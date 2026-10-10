import { Injectable, Logger } from '@nestjs/common';
import { isAddress } from 'viem';
import { isZeroAddress, normalizeAddress } from '../common/utils/address.util';
import { Erc20Reader } from './erc20.reader';
import { TransferDelta, TransferLogReader } from './transfer-log.reader';

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

interface DeltaAnchor {
  key: string;
  /** Deltas cover every Transfer with blockNumber > afterBlock, through scannedTo. */
  afterBlock: bigint;
  scannedTo: bigint;
  deltas: Map<string, bigint>;
}

/**
 * HyperEVM `balanceOf` is only reliable at the current head. Any other block
 * returns 0. Reconstruct the balance at the end of an older block as:
 *
 *   balance(block) = balance(head) - net Transfer delta after that block
 *
 * One token-wide log scan is cached and resumed, so later holders and sync
 * ticks do not walk the same range again.
 */
@Injectable()
export class BalanceRewindService {
  private readonly logger = new Logger(BalanceRewindService.name);
  private anchor: DeltaAnchor | null = null;
  private tail: Promise<void> = Promise.resolve();

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
    this.assertAddresses(params.tokenAddress, params.holderAddress);
    const holder = normalizeAddress(params.holderAddress);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const head = await this.catchUp(params, params.blockNumber);
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
          `Head moved ${head} -> ${headAfter} while reading balanceOf for ${holder}; retry ${attempt}/5`,
        );
        continue;
      }

      const delta = this.anchor?.deltas.get(holder) ?? 0n;
      const rewound = balance - delta;
      if (rewound < 0n) {
        throw new Error(
          `Rewound balance for ${holder} is negative (${rewound}) at end of block ${params.blockNumber}`,
        );
      }

      this.logger.log(
        `Rewound ${holder} = ${rewound} at end of block ${params.blockNumber} (head ${head} balance ${balance}, later delta ${delta})`,
      );
      return rewound;
    }

    throw new Error(`Head kept moving while reading balanceOf for ${holder}`);
  }

  private async catchUp(
    params: RewindBalanceParams,
    afterBlock: bigint,
  ): Promise<bigint> {
    return this.runExclusive(async () => {
      this.prepareAnchor(params, afterBlock);
      const head = await this.transferLogReader.getLatestBlockNumber(
        params.chainId,
        params.rpcUrl,
        params.chainName,
      );
      await this.extendScan(params, head);
      return this.anchor!.scannedTo < head ? head : this.anchor!.scannedTo;
    });
  }

  private prepareAnchor(params: RewindBalanceParams, afterBlock: bigint): void {
    const key = `${params.chainId}:${normalizeAddress(params.tokenAddress)}`;
    if (
      this.anchor &&
      this.anchor.key === key &&
      this.anchor.afterBlock <= afterBlock
    ) {
      // A newer checkpoint reuses this anchor. Holders with no balance row have
      // no Transfer between afterBlock and that checkpoint, so the gap adds 0.
      return;
    }

    this.anchor = {
      key,
      afterBlock,
      scannedTo: afterBlock,
      deltas: new Map(),
    };
  }

  private async extendScan(
    params: RewindBalanceParams,
    toBlock: bigint,
  ): Promise<void> {
    const anchor = this.anchor!;
    let start = anchor.scannedTo + 1n;
    if (start > toBlock) {
      return;
    }

    const span = toBlock - start + 1n;
    this.logger.log(
      `Rewind scan ${start}..${toBlock} (${span} blocks) for balances after block ${anchor.afterBlock}`,
    );

    let chunks = 0;
    while (start <= toBlock) {
      const end =
        start + MAX_LOG_BLOCK_RANGE - 1n > toBlock
          ? toBlock
          : start + MAX_LOG_BLOCK_RANGE - 1n;
      const logs = await this.fetchDeltasWithRetry(params, start, end);
      for (const log of logs) {
        this.applyDelta(anchor, log);
      }
      anchor.scannedTo = end;
      chunks += 1;
      if (chunks % 20 === 0) {
        this.logger.log(`Rewind scan reached block ${anchor.scannedTo} / ${toBlock}`);
      }
      start = end + 1n;
    }
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

  private applyDelta(anchor: DeltaAnchor, transfer: TransferDelta): void {
    const from = transfer.from;
    const to = transfer.to;
    if (!isZeroAddress(from)) {
      anchor.deltas.set(from, (anchor.deltas.get(from) ?? 0n) - transfer.value);
    }
    if (!isZeroAddress(to)) {
      anchor.deltas.set(to, (anchor.deltas.get(to) ?? 0n) + transfer.value);
    }
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

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertAddresses(tokenAddress: string, holderAddress: string): void {
    if (!isAddress(tokenAddress) || !isAddress(holderAddress)) {
      throw new Error('Invalid token or holder address for balance rewind');
    }
  }
}
