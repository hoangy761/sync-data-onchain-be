import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  BalanceRewindService,
  ReconcileInvariantError,
} from '../blockchain/balance-rewind.service';
import {
  DecodedTransfer,
  TransferLogReader,
} from '../blockchain/transfer-log.reader';
import { TokenBalance } from '../balances/entities/token-balance.entity';
import { TokenBalanceHistory } from '../balances/entities/token-balance-history.entity';
import { ChainsService } from '../chains/chains.service';
import {
  isZeroAddress,
  normalizeAddress,
} from '../common/utils/address.util';
import { lockTokenWrites } from '../common/utils/token-write-lock';
import { Token } from '../tokens/entities/token.entity';
import { TokensService } from '../tokens/tokens.service';
import { CheckpointService } from './checkpoint.service';
import { SyncCheckpoint } from './entities/sync-checkpoint.entity';

/** Inclusive progress from the sync start block through the chain head, as "0.00"–"100.00". */
export function syncPercent(
  startBlock: string,
  lastProcessedBlock: string,
  currentBlock: string | null,
): string | null {
  if (currentBlock == null) return null;

  const start = BigInt(startBlock);
  const last = BigInt(lastProcessedBlock);
  const current = BigInt(currentBlock);
  const total = current >= start ? current - start + 1n : 1n;
  const doneRaw = last + 1n > start ? last + 1n - start : 0n;
  const done = doneRaw > total ? total : doneRaw;
  const basisPoints = (done * 10000n) / total;
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** The in-flight range would drive a holder below zero. The database transaction rolls back. */
export class NegativeBalanceError extends Error {
  constructor(
    readonly holder: string,
    readonly txHash: string,
    readonly logIndex: number,
    readonly before: bigint,
  ) {
    super(
      `Negative balance for ${holder} at ${txHash}:${logIndex} from stored balance ${before}`,
    );
  }
}

/** Stored history cannot be reconciled with head balanceOf. Sync stops for this token. */
export class BalanceInvariantError extends Error {}

const MAX_BALANCE_REPAIRS = 50;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly haltedTokens = new Set<string>();

  constructor(
    private readonly tokensService: TokensService,
    private readonly chainsService: ChainsService,
    private readonly checkpointService: CheckpointService,
    private readonly transferLogReader: TransferLogReader,
    private readonly balanceRewind: BalanceRewindService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(TokenBalance)
    private readonly balancesRepo: Repository<TokenBalance>,
    @InjectRepository(TokenBalanceHistory)
    private readonly historyRepo: Repository<TokenBalanceHistory>,
    @InjectRepository(SyncCheckpoint)
    private readonly checkpointsRepo: Repository<SyncCheckpoint>,
  ) {}

  async syncOnce(): Promise<void> {
    const tokens = await this.tokensService.findEnabled();
    for (const token of tokens) {
      const key = `${token.chainId}:${token.tokenAddress}`;
      if (this.haltedTokens.has(key)) {
        continue;
      }
      try {
        await this.syncTokenRange(token);
      } catch (err) {
        if (
          err instanceof BalanceInvariantError ||
          err instanceof ReconcileInvariantError
        ) {
          this.haltedTokens.add(key);
          this.logger.error(
            `Sync halted for ${token.symbol} (${token.tokenAddress}): ${err.message}`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  async getSyncStatus(chainId: number, tokenAddress: string) {
    const token = await this.tokensService.findOne(chainId, tokenAddress);
    const chain = await this.chainsService.findOne(chainId);
    const checkpoint = await this.checkpointService.get(chainId, tokenAddress);

    let latestBlock: string | null = null;
    let safeHead: string | null = null;
    let lag: string | null = null;

    try {
      const confirmationDepth = this.config.get<number>(
        'sync.confirmationDepth',
      )!;
      const latest = await this.transferLogReader.getLatestBlockNumber(
        chain.chainId,
        chain.rpcUrl,
        chain.name,
      );
      const safe =
        latest > BigInt(confirmationDepth)
          ? latest - BigInt(confirmationDepth)
          : 0n;
      latestBlock = latest.toString();
      safeHead = safe.toString();
      const last = BigInt(checkpoint.lastProcessedBlock);
      lag = (safe > last ? safe - last : 0n).toString();
    } catch (err) {
      this.logger.warn(
        `Could not fetch latest block for sync-status: ${(err as Error).message}`,
      );
    }

    return {
      chainId: token.chainId,
      tokenAddress: token.tokenAddress,
      symbol: token.symbol,
      enabled: token.enabled,
      deploymentBlock: token.deploymentBlock,
      lastProcessedBlock: checkpoint.lastProcessedBlock,
      lastBlockHash: checkpoint.lastBlockHash,
      latestBlock,
      safeHead,
      lagBlocks: lag,
      syncPercent: syncPercent(
        token.deploymentBlock,
        checkpoint.lastProcessedBlock,
        latestBlock,
      ),
      updatedAt: checkpoint.updatedAt.toISOString(),
    };
  }

  private async syncTokenRange(token: Token): Promise<void> {
    const chain = await this.chainsService.getEnabled(token.chainId);
    const blockRange = BigInt(this.config.get<number>('sync.blockRange')!);
    const confirmationDepth = BigInt(
      this.config.get<number>('sync.confirmationDepth')!,
    );
    const maxAttempts = this.config.get<number>('sync.retryMaxAttempts')!;
    const baseDelay = this.config.get<number>('sync.retryBaseDelayMs')!;

    await this.withRetry(async () => {
      const checkpoint = await this.checkpointService.get(
        token.chainId,
        token.tokenAddress,
      );

      const latest = await this.transferLogReader.getLatestBlockNumber(
        chain.chainId,
        chain.rpcUrl,
        chain.name,
      );
      const safeHead =
        latest > confirmationDepth ? latest - confirmationDepth : 0n;
      const fromBlock = BigInt(checkpoint.lastProcessedBlock) + 1n;

      if (fromBlock > safeHead) {
        this.logger.debug(
          `Token ${token.symbol} caught up (from=${fromBlock}, safeHead=${safeHead})`,
        );
        return;
      }

      const toBlock =
        fromBlock + blockRange - 1n > safeHead
          ? safeHead
          : fromBlock + blockRange - 1n;

      this.logger.log(
        `Syncing ${token.symbol} blocks ${fromBlock}..${toBlock} on chain ${chain.chainId}`,
      );

      const transfers = await this.transferLogReader.getTransferLogs(
        chain.chainId,
        chain.rpcUrl,
        token.tokenAddress,
        fromBlock,
        toBlock,
        chain.name,
      );

      const endBlock = await this.transferLogReader.getBlock(
        chain.chainId,
        chain.rpcUrl,
        toBlock,
        chain.name,
      );

      const baselines = await this.baselineNewHolders(
        token,
        chain.rpcUrl,
        chain.name,
        transfers,
        fromBlock - 1n,
      );

      for (let repair = 0; ; repair++) {
        try {
          await this.dataSource.transaction(async (manager) => {
            await lockTokenWrites(manager, token.chainId, token.tokenAddress);
            await this.applyTransfers(manager, token, transfers, baselines);
            await manager.getRepository(SyncCheckpoint).save({
              chainId: token.chainId,
              tokenAddress: token.tokenAddress,
              lastProcessedBlock: toBlock.toString(),
              lastBlockHash: endBlock.hash,
            });
          });
          break;
        } catch (err) {
          if (!(err instanceof NegativeBalanceError)) {
            throw err;
          }
          if (repair >= MAX_BALANCE_REPAIRS) {
            throw new BalanceInvariantError(
              `Sync halted after ${MAX_BALANCE_REPAIRS} balance repairs; last error: ${err.message}`,
            );
          }
          this.logger.warn(`Repairing stored balance after ${err.message}`);
          await this.repairCommittedBalance(
            token,
            chain.rpcUrl,
            chain.name,
            err.holder,
          );
        }
      }

      this.logger.log(
        `Synced ${token.symbol}: ${transfers.length} transfer(s), checkpoint=${toBlock}`,
      );
    }, maxAttempts, baseDelay);
  }

  /**
   * Holders with no balance row yet cannot use historical balanceOf on HyperEVM.
   * Seed them from the live head balance minus this holder's own Transfers after
   * `targetBlock` (the checkpoint). That is the balance just before their first
   * indexed transfer.
   */
  private async baselineNewHolders(
    token: Token,
    rpcUrl: string,
    chainName: string,
    transfers: DecodedTransfer[],
    targetBlock: bigint,
  ): Promise<Map<string, bigint>> {
    const firstTransfer = new Map<string, DecodedTransfer>();
    for (const transfer of transfers) {
      for (const { holder } of this.affectedHolders(transfer)) {
        if (!firstTransfer.has(holder)) {
          firstTransfer.set(holder, transfer);
        }
      }
    }

    const baselines = new Map<string, bigint>();
    for (const [holder, transfer] of firstTransfer) {
      const existing = await this.balancesRepo.findOne({
        where: {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
      });
      if (existing) {
        continue;
      }

      const txHash = transfer.txHash.toLowerCase();
      const processed = await this.historyRepo.findOne({
        where: {
          chainId: token.chainId,
          txHash,
          logIndex: transfer.logIndex,
          holderAddress: holder,
        },
      });
      if (processed) {
        throw new Error(
          `History exists for ${holder} at ${txHash}:${transfer.logIndex} but token_balances row is missing`,
        );
      }

      const before = await this.balanceRewind.balanceAtEndOfBlock({
        chainId: token.chainId,
        rpcUrl,
        tokenAddress: token.tokenAddress,
        holderAddress: holder,
        blockNumber: targetBlock,
        chainName,
      });
      baselines.set(holder, before);
      this.logger.log(
        `Baseline ${holder} = ${before} reconciled from holder logs at end of block ${targetBlock}`,
      );
    }

    return baselines;
  }

  private async applyTransfers(
    manager: EntityManager,
    token: Token,
    transfers: DecodedTransfer[],
    baselines: Map<string, bigint>,
  ): Promise<void> {
    const balanceRepo = manager.getRepository(TokenBalance);
    const historyRepo = manager.getRepository(TokenBalanceHistory);
    const balanceCache = new Map<string, bigint>();
    const knownHolders = new Set<string>();

    const loadBalance = async (holder: string): Promise<bigint | null> => {
      if (balanceCache.has(holder)) {
        return balanceCache.get(holder)!;
      }
      const row = await balanceRepo.findOne({
        where: {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
      });
      if (!row) {
        return null;
      }
      const value = BigInt(row.balance);
      balanceCache.set(holder, value);
      knownHolders.add(holder);
      return value;
    };

    const alreadyProcessed = async (
      holder: string,
      txHash: string,
      logIndex: number,
    ): Promise<boolean> => {
      const existing = await historyRepo.findOne({
        where: {
          chainId: token.chainId,
          txHash: txHash.toLowerCase(),
          logIndex,
          holderAddress: holder,
        },
      });
      return !!existing;
    };

    for (const transfer of transfers) {
      const txHash = transfer.txHash.toLowerCase();
      const holders = this.affectedHolders(transfer);

      for (const { holder, delta } of holders) {
        if (await alreadyProcessed(holder, txHash, transfer.logIndex)) {
          continue;
        }

        let before = await loadBalance(holder);
        if (before == null) {
          const seeded = baselines.get(holder);
          if (seeded == null) {
            throw new Error(
              `Missing rewound baseline for ${holder} at ${txHash}:${transfer.logIndex}`,
            );
          }
          before = seeded;
        }

        const after = before + delta;
        if (after < 0n) {
          throw new NegativeBalanceError(
            holder,
            txHash,
            transfer.logIndex,
            before,
          );
        }

        await historyRepo.insert({
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
          blockNumber: transfer.blockNumber.toString(),
          blockHash: transfer.blockHash,
          blockTimestamp: transfer.blockTimestamp,
          transactionIndex: transfer.transactionIndex,
          txHash,
          logIndex: transfer.logIndex,
          balanceBefore: before.toString(),
          balanceAfter: after.toString(),
          delta: delta.toString(),
        });

        await balanceRepo.save({
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
          balance: after.toString(),
          updatedBlock: transfer.blockNumber.toString(),
          updatedLogIndex: transfer.logIndex,
        });

        balanceCache.set(holder, after);
        knownHolders.add(holder);
      }
    }
  }

  private affectedHolders(
    transfer: DecodedTransfer,
  ): Array<{ holder: string; delta: bigint }> {
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);
    const value = transfer.value;

    if (from === to) {
      if (isZeroAddress(from)) {
        return [];
      }
      return [{ holder: from, delta: 0n }];
    }

    const updates: Array<{ holder: string; delta: bigint }> = [];
    if (!isZeroAddress(from)) {
      updates.push({ holder: from, delta: -value });
    }
    if (!isZeroAddress(to)) {
      updates.push({ holder: to, delta: value });
    }
    return updates;
  }

  /**
   * The committed balance is short of the head rewind. Shift every stored
   * balance for this holder by that constant, then let the range apply again.
   * Deltas stay as indexed. A repair that cannot explain the debit aborts sync.
   */
  private async repairCommittedBalance(
    token: Token,
    rpcUrl: string,
    chainName: string,
    holder: string,
  ): Promise<void> {
    const row = await this.balancesRepo.findOne({
      where: {
        chainId: token.chainId,
        tokenAddress: token.tokenAddress,
        holderAddress: holder,
      },
    });
    if (!row) {
      throw new BalanceInvariantError(
        `No committed balance to repair for ${holder}. Holder-log baseline still cannot cover the next transfer`,
      );
    }

    const stored = BigInt(row.balance);
    const cursorBlock = BigInt(row.updatedBlock);
    const cursorLog = row.updatedLogIndex;
    const corrected = await this.balanceRewind.balanceAtCursor({
      chainId: token.chainId,
      rpcUrl,
      tokenAddress: token.tokenAddress,
      holderAddress: holder,
      blockNumber: cursorBlock,
      logIndex: cursorLog,
      chainName,
    });
    const shortfall = corrected - stored;
    if (shortfall === 0n) {
      throw new BalanceInvariantError(
        `Stored balance for ${holder} already matches the head rewind (${stored}) at block ${cursorBlock}, but a later transfer still goes negative`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await lockTokenWrites(manager, token.chainId, token.tokenAddress);
      const current = await manager.getRepository(TokenBalance).findOne({
        where: {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
      });
      if (
        !current ||
        current.updatedBlock !== row.updatedBlock ||
        current.updatedLogIndex !== row.updatedLogIndex ||
        BigInt(current.balance) !== stored
      ) {
        throw new Error(
          `Balance cursor for ${holder} changed while repairing; retry`,
        );
      }

      const historyRepo = manager.getRepository(TokenBalanceHistory);
      const latest = await historyRepo.findOne({
        where: {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
        order: {
          blockNumber: 'DESC',
          transactionIndex: 'DESC',
          logIndex: 'DESC',
        },
      });
      if (latest && BigInt(latest.balanceAfter) !== stored) {
        throw new BalanceInvariantError(
          `History for ${holder} ends at ${latest.balanceAfter}, stored balance is ${stored}`,
        );
      }
      if (
        latest &&
        this.historyAfterCursor(latest, cursorBlock, cursorLog)
      ) {
        throw new BalanceInvariantError(
          `History for ${holder} extends past balance cursor ${cursorBlock}:${cursorLog ?? 'end'}`,
        );
      }

      const negative = await manager.query(
        `SELECT COUNT(*)::int AS n
         FROM token_balance_history
         WHERE chain_id = $1
           AND token_address = $2
           AND holder_address = $3
           AND (
             balance_before + $4::numeric < 0
             OR balance_after + $4::numeric < 0
           )`,
        [token.chainId, token.tokenAddress, holder, shortfall.toString()],
      );
      const negativeCount = Number(negative?.[0]?.n ?? 0);
      if (negativeCount > 0) {
        throw new BalanceInvariantError(
          `Repairing ${holder} by ${shortfall} would make a stored balance negative`,
        );
      }

      await manager.query(
        `UPDATE token_balance_history
         SET balance_before = balance_before + $4::numeric,
             balance_after = balance_after + $4::numeric
         WHERE chain_id = $1
           AND token_address = $2
           AND holder_address = $3`,
        [token.chainId, token.tokenAddress, holder, shortfall.toString()],
      );
      await manager.getRepository(TokenBalance).update(
        {
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          holderAddress: holder,
        },
        { balance: corrected.toString() },
      );
    });

    this.logger.warn(
      `Repaired ${holder} balance ${stored} -> ${corrected} (shortfall ${shortfall}) at block ${cursorBlock}`,
    );
  }

  private historyAfterCursor(
    row: { blockNumber: string; logIndex: number },
    cursorBlock: bigint,
    cursorLog: number | null,
  ): boolean {
    const block = BigInt(row.blockNumber);
    if (block > cursorBlock) {
      return true;
    }
    if (block < cursorBlock || cursorLog == null) {
      return false;
    }
    return row.logIndex > cursorLog;
  }

  private async withRetry(
    fn: () => Promise<void>,
    maxAttempts: number,
    baseDelayMs: number,
  ): Promise<void> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        await fn();
        return;
      } catch (err) {
        if (
          err instanceof BalanceInvariantError ||
          err instanceof ReconcileInvariantError ||
          attempt >= maxAttempts
        ) {
          throw err;
        }
        const delay = baseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `Sync attempt ${attempt} failed: ${(err as Error).message}; retry in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
