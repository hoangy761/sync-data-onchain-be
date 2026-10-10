import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { BalanceRewindService } from "../blockchain/balance-rewind.service";
import {
  DecodedTransfer,
  TransferLogReader,
} from "../blockchain/transfer-log.reader";
import { ChainsService } from "../chains/chains.service";
import { isZeroAddress, normalizeAddress } from "../common/utils/address.util";
import { lockTokenWrites } from "../common/utils/token-write-lock";
import { Token } from "../tokens/entities/token.entity";
import { TokensService } from "../tokens/tokens.service";
import { HolderSyncTask } from "./entities/holder-sync-task.entity";
import { TokenBalance } from "./entities/token-balance.entity";
import { TokenBalanceHistory } from "./entities/token-balance-history.entity";

export interface ConfirmedSnapshot {
  balance: bigint;
  blockNumber: bigint;
}

interface HistoryDraft {
  blockNumber: string;
  blockHash: string;
  blockTimestamp: Date;
  transactionIndex: number;
  txHash: string;
  logIndex: number;
  balanceBefore: string;
  balanceAfter: string;
  delta: string;
}

interface HolderCursor {
  /** First block that still needs this holder's Transfer logs. */
  fromBlock: bigint;
  /** Balance at the end of `fromBlock - 1`. Null when the holder has no stored state. */
  startBalance: bigint | null;
  coveredBlock: bigint;
}

type ChunkResult =
  | { type: "wrote"; reached: boolean; targetBlock: string; balance: string }
  | { type: "skip" }
  | { type: "retry" }
  | { type: "mismatch"; message: string };

const INSERT_BATCH = 300;
/** One cron tick reads this many blocks, then yields so other RPC work can proceed. */
const BLOCKS_PER_TICK = 2000n;

/**
 * Reads the confirmed balance on the request path.
 * Each catch-up chunk writes its history immediately. `token_balances` is
 * updated when the scan reaches `targetBlock`.
 */
@Injectable()
export class HolderBackfillService implements OnModuleInit {
  private readonly logger = new Logger(HolderBackfillService.name);
  private readonly inflight = new Map<string, Promise<ConfirmedSnapshot>>();

  constructor(
    @InjectRepository(TokenBalance)
    private readonly balancesRepo: Repository<TokenBalance>,
    @InjectRepository(HolderSyncTask)
    private readonly tasksRepo: Repository<HolderSyncTask>,
    private readonly tokensService: TokensService,
    private readonly chainsService: ChainsService,
    private readonly balanceRewind: BalanceRewindService,
    private readonly transferLogReader: TransferLogReader,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.tasksRepo.query(`
      UPDATE holder_sync_tasks
      SET status = 'pending',
          next_block = scan_from_block,
          updated_at = NOW()
      WHERE status = 'running'
    `);
  }

  /** Confirmed balance at `head - SYNC_CONFIRMATION_DEPTH`. Does not wait for history. */
  readConfirmed(token: Token, holder: string): Promise<ConfirmedSnapshot> {
    const key = this.holderKey(token, holder);
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }
    const job = this.loadConfirmed(token, holder).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, job);
    return job;
  }

  /** Advance the oldest queued holder by one block chunk. */
  async processScheduledChunk(): Promise<void> {
    const task =
      (await this.tasksRepo.findOne({
        where: { status: "running" },
        order: { createdAt: "ASC" },
      })) ??
      (await this.tasksRepo.findOne({
        where: { status: "pending" },
        order: { createdAt: "ASC" },
      }));
    if (!task) {
      return;
    }

    const token = await this.tokensService.findOne(
      task.chainId,
      task.tokenAddress,
    );
    const chain = await this.chainsService.getEnabled(task.chainId);
    await this.refreshTarget(task);
    if (await this.realignToCursor(task, token)) {
      return;
    }
    const target = BigInt(task.targetBlock);
    const from = BigInt(task.nextBlock);
    if (from > target) {
      await this.applyChunk(task, token, [], from - 1n);
      return;
    }

    const end =
      from + BLOCKS_PER_TICK - 1n > target
        ? target
        : from + BLOCKS_PER_TICK - 1n;
    let logs: DecodedTransfer[];
    try {
      logs = await this.transferLogReader.getHolderTransferLogs(
        chain.chainId,
        chain.rpcUrl,
        token.tokenAddress,
        task.holderAddress,
        from,
        end,
        chain.name,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Holder sync paused for ${task.holderAddress} at ${from}..${end}: ${message}`,
      );
      return;
    }

    await this.refreshTarget(task);
    await this.applyChunk(task, token, logs, end);
  }

  private async loadConfirmed(
    token: Token,
    holder: string,
  ): Promise<ConfirmedSnapshot> {
    const chain = await this.chainsService.getEnabled(token.chainId);
    const depth = BigInt(this.config.get<number>("sync.confirmationDepth")!);
    const confirmed = await this.balanceRewind.balanceAtConfirmedHead(
      {
        chainId: chain.chainId,
        rpcUrl: chain.rpcUrl,
        tokenAddress: token.tokenAddress,
        holderAddress: holder,
        chainName: chain.name,
      },
      depth,
    );
    const snapshot = {
      balance: confirmed.balance,
      blockNumber: confirmed.blockNumber,
    };
    if (!isZeroAddress(holder)) {
      try {
        await this.scheduleCatchUp(token, holder, snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to schedule holder catch-up for ${holder}: ${message}`,
        );
      }
    }
    return snapshot;
  }

  private async scheduleCatchUp(
    token: Token,
    holder: string,
    confirmed: ConfirmedSnapshot,
  ): Promise<void> {
    const cursor = await this.cursorFor(token, holder);
    if (cursor.coveredBlock >= confirmed.blockNumber) {
      return;
    }

    const deployment = BigInt(token.deploymentBlock);
    const scanFrom =
      cursor.fromBlock > deployment ? cursor.fromBlock : deployment;
    const existing = await this.tasksRepo.findOne({
      where: {
        chainId: token.chainId,
        tokenAddress: token.tokenAddress,
        holderAddress: holder,
      },
    });

    if (existing) {
      return;
    }

    const row = existing ?? this.tasksRepo.create();
    row.chainId = token.chainId;
    row.tokenAddress = token.tokenAddress;
    row.holderAddress = holder;
    row.targetBlock = confirmed.blockNumber.toString();
    row.confirmedBalance = confirmed.balance.toString();
    row.scanFromBlock = scanFrom.toString();
    row.nextBlock = scanFrom.toString();
    row.startBalance = cursor.startBalance?.toString() ?? null;
    row.status = "pending";
    row.lastError = null;
    await this.tasksRepo.save(row);
    this.logger.log(
      `Scheduled catch-up for ${holder} from block ${scanFrom} through ${confirmed.blockNumber}`,
    );
  }

  /**
   * Stop when stored history already covers the target, or restart when the
   * cursor no longer matches this attempt. Returns true when this tick should stop.
   */
  private async realignToCursor(
    task: HolderSyncTask,
    token: Token,
  ): Promise<boolean> {
    const cursor = await this.cursorFor(token, task.holderAddress);
    if (cursor.coveredBlock >= BigInt(task.targetBlock)) {
      await this.markDone(task);
      return true;
    }

    const scanFrom = this.cursorScanFrom(token, cursor);
    const expectedStart =
      task.startBalance == null ? null : BigInt(task.startBalance);
    if (
      scanFrom === BigInt(task.scanFromBlock) &&
      this.sameBalance(cursor.startBalance, expectedStart)
    ) {
      return false;
    }

    await this.restartFromCursor(task, token, cursor);
    return true;
  }

  /**
   * Replay this chunk onto the stored balance and persist it.
   * A null start balance means the holder has no stored state, so the walk
   * starts at 0. The confirmed balance is checked when `end` reaches the
   * target. A scan with no transfers still stores that confirmed balance.
   */
  private async applyChunk(
    task: HolderSyncTask,
    token: Token,
    logs: DecodedTransfer[],
    end: bigint,
  ): Promise<void> {
    const opening =
      task.startBalance == null ? null : BigInt(task.startBalance);
    let history: HistoryDraft[] = [];
    let running = opening;
    try {
      if (logs.length > 0) {
        const applied = this.applyLogs(task.holderAddress, logs, opening ?? 0n);
        history = applied.history;
        running = applied.running;
      }
    } catch (error) {
      await this.failTask(task, error);
      return;
    }

    const result = await this.persistChunk(token, task, history, running, end);
    if (result.type === "mismatch") {
      await this.failTask(task, new Error(result.message));
      return;
    }
    if (result.type === "retry") {
      await this.restartFromCursor(task, token);
      return;
    }
    if (result.type === "skip") {
      await this.markDone(task);
      this.logger.log(
        `Holder catch-up ${task.holderAddress} already covered through block ${task.targetBlock}`,
      );
      return;
    }
    if (result.reached) {
      this.logger.log(
        `Caught up ${task.holderAddress} for ${token.symbol ?? token.tokenAddress} through block ${result.targetBlock}, balance ${result.balance}`,
      );
      return;
    }
    this.logger.log(
      `Holder catch-up ${task.holderAddress} scanned through block ${end} / ${result.targetBlock} (+${history.length} history row(s))`,
    );
  }

  private async persistChunk(
    token: Token,
    task: HolderSyncTask,
    history: HistoryDraft[],
    running: bigint | null,
    end: bigint,
  ): Promise<ChunkResult> {
    const holder = task.holderAddress;
    const expectedFrom = BigInt(task.scanFromBlock);
    const expectedStart =
      task.startBalance == null ? null : BigInt(task.startBalance);

    return this.dataSource.transaction(async (manager) => {
      await lockTokenWrites(manager, token.chainId, token.tokenAddress);
      const latest = await manager.getRepository(HolderSyncTask).findOneBy({
        id: task.id,
      });
      if (!latest) {
        return { type: "skip" };
      }
      const target = BigInt(latest.targetBlock);
      const confirmedBalance = BigInt(latest.confirmedBalance);
      const reached = end >= target;
      const fresh = await this.cursorFor(token, holder, manager);
      if (fresh.coveredBlock >= target) {
        return { type: "skip" };
      }
      const freshFrom = this.cursorScanFrom(token, fresh);
      if (
        freshFrom !== expectedFrom ||
        !this.sameBalance(fresh.startBalance, expectedStart)
      ) {
        return { type: "retry" };
      }
      if (reached && running != null && running !== confirmedBalance) {
        const wholeWindowEmpty =
          history.length === 0 && task.nextBlock === task.scanFromBlock;
        return {
          type: "mismatch",
          message: wholeWindowEmpty
            ? `Holder ${holder} has no Transfer in the catch-up window but stored balance ${running} != confirmed ${confirmedBalance}`
            : `Holder ${holder} catch-up ended at ${running}, confirmed balance is ${confirmedBalance}`,
        };
      }

      if (history.length > 0) {
        const historyRepo = manager.getRepository(TokenBalanceHistory);
        for (let offset = 0; offset < history.length; offset += INSERT_BATCH) {
          const chunk = history
            .slice(offset, offset + INSERT_BATCH)
            .map((row) => ({
              chainId: token.chainId,
              tokenAddress: token.tokenAddress,
              holderAddress: holder,
              ...row,
            }));
          await historyRepo
            .createQueryBuilder()
            .insert()
            .into(TokenBalanceHistory)
            .values(chunk)
            .orIgnore()
            .execute();
        }
      }

      const last = history[history.length - 1];
      if (reached) {
        const updatedLogIndex =
          last && BigInt(last.blockNumber) === target ? last.logIndex : null;
        await manager.getRepository(TokenBalance).save({
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
          balance: confirmedBalance.toString(),
          updatedBlock: target.toString(),
          updatedLogIndex,
        });
      }

      await manager.getRepository(HolderSyncTask).update(task.id, {
        nextBlock: (end + 1n).toString(),
        status: reached ? "done" : "running",
        lastError: null,
        ...(last
          ? {
              scanFromBlock: (BigInt(last.blockNumber) + 1n).toString(),
              startBalance: running!.toString(),
            }
          : {}),
      });

      return {
        type: "wrote",
        reached,
        targetBlock: target.toString(),
        balance: confirmedBalance.toString(),
      };
    });
  }

  private async refreshTarget(task: HolderSyncTask): Promise<void> {
    const latest = await this.tasksRepo.findOneBy({ id: task.id });
    if (!latest) {
      return;
    }
    task.targetBlock = latest.targetBlock;
    task.confirmedBalance = latest.confirmedBalance;
  }

  private async markDone(task: HolderSyncTask): Promise<void> {
    await this.tasksRepo.update(task.id, {
      status: "done",
      lastError: null,
    });
  }

  private async failTask(task: HolderSyncTask, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.tasksRepo.update(task.id, {
      status: "failed",
      lastError: message.slice(0, 2000),
    });
    this.logger.error(
      `Holder catch-up failed for ${task.holderAddress}: ${message}`,
    );
  }

  private async restartFromCursor(
    task: HolderSyncTask,
    token: Token,
    cursor?: HolderCursor,
  ): Promise<void> {
    const fresh = cursor ?? (await this.cursorFor(token, task.holderAddress));
    if (fresh.coveredBlock >= BigInt(task.targetBlock)) {
      await this.markDone(task);
      return;
    }
    const scanFrom = this.cursorScanFrom(token, fresh);
    await this.tasksRepo.update(task.id, {
      scanFromBlock: scanFrom.toString(),
      nextBlock: scanFrom.toString(),
      startBalance: fresh.startBalance?.toString() ?? null,
      status: "pending",
      lastError: null,
    });
    this.logger.warn(
      `Holder ${task.holderAddress} cursor moved; catch-up restarts at block ${scanFrom}`,
    );
  }

  private cursorScanFrom(token: Token, cursor: HolderCursor): bigint {
    const deployment = BigInt(token.deploymentBlock);
    return cursor.fromBlock > deployment ? cursor.fromBlock : deployment;
  }

  private async cursorFor(
    token: Token,
    holder: string,
    manager = this.balancesRepo.manager,
  ): Promise<HolderCursor> {
    const balance = await manager.getRepository(TokenBalance).findOne({
      where: {
        chainId: token.chainId,
        tokenAddress: token.tokenAddress,
        holderAddress: holder,
      },
    });
    const lastHistory = await manager
      .getRepository(TokenBalanceHistory)
      .findOne({
        where: {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
        order: {
          blockNumber: "DESC",
          transactionIndex: "DESC",
          logIndex: "DESC",
        },
      });

    const balanceBlock = balance ? BigInt(balance.updatedBlock) : null;
    const historyBlock = lastHistory ? BigInt(lastHistory.blockNumber) : null;
    const coveredBlock = this.laterBlock(balanceBlock, historyBlock);

    if (
      lastHistory &&
      (balanceBlock == null || historyBlock! >= balanceBlock)
    ) {
      return {
        fromBlock: historyBlock! + 1n,
        startBalance: BigInt(lastHistory.balanceAfter),
        coveredBlock: coveredBlock ?? historyBlock!,
      };
    }
    if (balance && balanceBlock != null) {
      return {
        fromBlock: balanceBlock + 1n,
        startBalance: BigInt(balance.balance),
        coveredBlock: balanceBlock,
      };
    }

    const deployment = BigInt(token.deploymentBlock);
    return {
      fromBlock: deployment,
      startBalance: null,
      coveredBlock: deployment - 1n,
    };
  }

  private laterBlock(left: bigint | null, right: bigint | null): bigint | null {
    if (left == null) return right;
    if (right == null) return left;
    return left > right ? left : right;
  }

  private sameBalance(left: bigint | null, right: bigint | null): boolean {
    if (left == null || right == null) {
      return left == null && right == null;
    }
    return left === right;
  }

  private applyLogs(
    holder: string,
    logs: DecodedTransfer[],
    running: bigint,
  ): { history: HistoryDraft[]; running: bigint } {
    if (running < 0n) {
      throw new Error(
        `Holder ${holder} catch-up starts negative (${running}) before ${logs.length} transfer(s)`,
      );
    }

    const history: HistoryDraft[] = [];
    for (const log of logs) {
      const delta = this.holderDelta(holder, log);
      const before = running;
      const after = before + delta;
      if (after < 0n) {
        throw new Error(
          `Negative balance for ${holder} at ${log.txHash}:${log.logIndex}`,
        );
      }
      running = after;
      history.push({
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        blockTimestamp: log.blockTimestamp,
        transactionIndex: log.transactionIndex,
        txHash: log.txHash.toLowerCase(),
        logIndex: log.logIndex,
        balanceBefore: before.toString(),
        balanceAfter: after.toString(),
        delta: delta.toString(),
      });
    }
    return { history, running };
  }

  private holderDelta(holder: string, transfer: DecodedTransfer): bigint {
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);
    let delta = 0n;
    if (from === holder && !isZeroAddress(from)) {
      delta -= transfer.value;
    }
    if (to === holder && !isZeroAddress(to)) {
      delta += transfer.value;
    }
    return delta;
  }

  private holderKey(token: Token, holder: string): string {
    return `${token.chainId}:${token.tokenAddress}:${holder}`;
  }
}
