import { Injectable, Logger } from '@nestjs/common';
import { isAddress } from 'viem';
import { isZeroAddress, normalizeAddress } from '../common/utils/address.util';
import { Erc20Reader } from './erc20.reader';
import {
  HolderCursorDelta,
  TransferDelta,
  TransferLogReader,
} from './transfer-log.reader';

/** Holder logs and head `balanceOf` disagree, so sync must stop for this token. */
export class ReconcileInvariantError extends Error {}

/** HyperEVM `eth_getLogs` rejects a wider span. */
const MAX_LOG_BLOCK_RANGE = 1000n;

export interface RewindBalanceParams {
  chainId: number;
  rpcUrl: string;
  tokenAddress: string;
  holderAddress: string;
  blockNumber: bigint;
  chainName?: string;
}

/**
 * HyperEVM `balanceOf` follows the live head. A historical block tag is not
 * that block's balance. Reconstruct an older balance as:
 *
 *   balance(cursor) = balance(head) - net Transfer delta strictly after the cursor
 *
 * Holder baselines use that holder's own `from` / `to` logs. A token-wide
 * log scan can miss a transfer that `balanceOf` has already applied and then
 * commit a balance short by exactly that transfer.
 */
@Injectable()
export class BalanceRewindService {
  private readonly logger = new Logger(BalanceRewindService.name);

  constructor(
    private readonly erc20Reader: Erc20Reader,
    private readonly transferLogReader: TransferLogReader,
  ) {}

  /**
   * Balance at `head - confirmationDepth`. Only the short tip is scanned, so
   * the result does not wait for the historical indexer.
   */
  async balanceAtConfirmedHead(
    params: Omit<RewindBalanceParams, 'blockNumber'>,
    confirmationDepth: bigint,
  ): Promise<{ balance: bigint; blockNumber: bigint; head: bigint }> {
    if (!isAddress(params.tokenAddress) || !isAddress(params.holderAddress)) {
      throw new Error('Invalid token or holder address for balance rewind');
    }

    const holder = normalizeAddress(params.holderAddress);
    const depth = confirmationDepth > 0n ? confirmationDepth : 0n;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const head = await this.transferLogReader.getLatestBlockNumber(
        params.chainId,
        params.rpcUrl,
        params.chainName,
      );
      const safe = head > depth ? head - depth : 0n;

      if (isZeroAddress(holder)) {
        const headAfter = await this.transferLogReader.getLatestBlockNumber(
          params.chainId,
          params.rpcUrl,
          params.chainName,
        );
        if (head !== headAfter) {
          continue;
        }
        return { balance: 0n, blockNumber: safe, head };
      }

      const logs =
        safe + 1n <= head
          ? await this.listDeltas(params, safe + 1n, head)
          : [];
      const balance = await this.erc20Reader.balanceOf(
        params.chainId,
        params.rpcUrl,
        params.tokenAddress,
        holder,
        undefined,
        params.chainName,
      );
      const headAfter = await this.transferLogReader.getLatestBlockNumber(
        params.chainId,
        params.rpcUrl,
        params.chainName,
      );
      if (head !== headAfter) {
        this.logger.debug(
          `Head moved ${head} -> ${headAfter} while reading confirmed balance for ${holder}; retry ${attempt}/5`,
        );
        continue;
      }

      const delta = this.holderNetDelta(holder, logs);
      const rewound = balance - delta;
      if (rewound < 0n) {
        throw new Error(
          `Confirmed balance for ${holder} is negative (${rewound}) at block ${safe}`,
        );
      }

      this.logger.log(
        `Confirmed ${holder} = ${rewound} at block ${safe} (head ${head}, tip delta ${delta})`,
      );
      return { balance: rewound, blockNumber: safe, head };
    }

    throw new Error(`Head kept moving while reading confirmed balance for ${holder}`);
  }

  async balanceAtEndOfBlock(params: RewindBalanceParams): Promise<bigint> {
    return this.balanceAtCursor(params);
  }

  /**
   * Balance just after `blockNumber`, including `logIndex` when it is set.
   * Omitting `logIndex` means the end of that block.
   */
  async balanceAtCursor(
    params: RewindBalanceParams & { logIndex?: number | null },
  ): Promise<bigint> {
    this.assertAddresses(params.tokenAddress, params.holderAddress);
    const holder = normalizeAddress(params.holderAddress);
    const cursorLog = params.logIndex ?? null;

    if (isZeroAddress(holder)) {
      return 0n;
    }

    const logs: HolderCursorDelta[] = [];
    let nextBlock =
      cursorLog == null ? params.blockNumber + 1n : params.blockNumber;

    for (let attempt = 1; attempt <= 8; attempt++) {
      const head = await this.transferLogReader.getLatestBlockNumber(
        params.chainId,
        params.rpcUrl,
        params.chainName,
      );
      if (head < params.blockNumber) {
        throw new Error(
          `Head ${head} is behind balance cursor block ${params.blockNumber} for ${holder}`,
        );
      }

      if (nextBlock <= head) {
        logs.push(
          ...(await this.transferLogReader.getHolderTransferDeltas(
            params.chainId,
            params.rpcUrl,
            params.tokenAddress,
            holder,
            nextBlock,
            head,
            params.chainName,
          )),
        );
        nextBlock = head + 1n;
      }

      const balance = await this.erc20Reader.balanceOf(
        params.chainId,
        params.rpcUrl,
        params.tokenAddress,
        holder,
        undefined,
        params.chainName,
      );
      const headAfter = await this.transferLogReader.getLatestBlockNumber(
        params.chainId,
        params.rpcUrl,
        params.chainName,
      );
      if (head !== headAfter) {
        this.logger.debug(
          `Head moved ${head} -> ${headAfter} while reconciling ${holder}; scanning the new tip`,
        );
        continue;
      }

      const delta = this.netDeltaAfterCursor(
        holder,
        logs,
        params.blockNumber,
        cursorLog,
      );
      const rewound = balance - delta;
      if (rewound < 0n) {
        throw new ReconcileInvariantError(
          `Reconciled balance for ${holder} is negative (${rewound}) at block ${params.blockNumber}`,
        );
      }

      this.logger.log(
        `Reconciled ${holder} = ${rewound} at block ${params.blockNumber}${
          cursorLog == null ? '' : ` log ${cursorLog}`
        } (head ${head} balance ${balance}, later delta ${delta})`,
      );
      return rewound;
    }

    throw new Error(`Head kept moving while reconciling balance for ${holder}`);
  }

  private netDeltaAfterCursor(
    holder: string,
    logs: HolderCursorDelta[],
    cursorBlock: bigint,
    cursorLog: number | null,
  ): bigint {
    let delta = 0n;
    for (const transfer of logs) {
      const after =
        cursorLog == null
          ? transfer.blockNumber > cursorBlock
          : transfer.blockNumber > cursorBlock ||
            (transfer.blockNumber === cursorBlock &&
              transfer.logIndex > cursorLog);
      if (!after) {
        continue;
      }
      if (transfer.from === holder && !isZeroAddress(transfer.from)) {
        delta -= transfer.value;
      }
      if (transfer.to === holder && !isZeroAddress(transfer.to)) {
        delta += transfer.value;
      }
    }
    return delta;
  }

  private async listDeltas(
    params: Omit<RewindBalanceParams, 'blockNumber'>,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<TransferDelta[]> {
    const logs: TransferDelta[] = [];
    let start = fromBlock;
    while (start <= toBlock) {
      const end =
        start + MAX_LOG_BLOCK_RANGE - 1n > toBlock
          ? toBlock
          : start + MAX_LOG_BLOCK_RANGE - 1n;
      logs.push(
        ...(await this.fetchDeltasWithRetry(
          { ...params, blockNumber: fromBlock },
          start,
          end,
        )),
      );
      start = end + 1n;
    }
    return logs;
  }

  private holderNetDelta(holder: string, logs: TransferDelta[]): bigint {
    let delta = 0n;
    for (const transfer of logs) {
      if (transfer.from === holder) {
        delta -= transfer.value;
      }
      if (transfer.to === holder) {
        delta += transfer.value;
      }
    }
    return delta;
  }

  private async fetchDeltasWithRetry(
    params: RewindBalanceParams,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<TransferDelta[]> {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.transferLogReader.getTransferDeltasInRange(
          params.chainId,
          params.rpcUrl,
          params.tokenAddress,
          fromBlock,
          toBlock,
          params.chainName,
        );
      } catch (err) {
        if (attempt >= maxAttempts || !this.isRetryable(err)) {
          throw err;
        }
        const delay = Math.min(8000, 500 * 2 ** (attempt - 1));
        this.logger.warn(
          `Rewind getLogs ${fromBlock}..${toBlock} failed: ${(err as Error).message}; retry in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return [];
  }

  private isRetryable(err: unknown): boolean {
    const message = (err as Error).message?.toLowerCase() ?? '';
    return (
      message.includes('cu limit') ||
      message.includes('too fast') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('unable to complete') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('etimedout')
    );
  }

  private assertAddresses(tokenAddress: string, holderAddress: string): void {
    if (!isAddress(tokenAddress) || !isAddress(holderAddress)) {
      throw new Error('Invalid token or holder address for balance rewind');
    }
  }
}
