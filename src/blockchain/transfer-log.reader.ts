import { Injectable, Logger } from "@nestjs/common";
import {
  type Address,
  type Hash,
  type Log,
  decodeEventLog,
  getAddress,
  parseAbiItem,
} from "viem";
import { erc20Abi } from "./abi/erc20.abi";
import { RpcClientFactory } from "./rpc-client.factory";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface DecodedTransfer {
  blockNumber: bigint;
  blockHash: Hash;
  transactionIndex: number;
  txHash: Hash;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  blockTimestamp: Date;
}

/** Transfer fields needed to rewind balances. Block timestamps are omitted. */
export interface TransferDelta {
  from: string;
  to: string;
  value: bigint;
}

/** HyperEVM `eth_getLogs` rejects a wider span. */
const MAX_LOG_BLOCK_RANGE = 1000n;

@Injectable()
export class TransferLogReader {
  private readonly logger = new Logger(TransferLogReader.name);

  constructor(private readonly rpcClientFactory: RpcClientFactory) {}

  async getLatestBlockNumber(
    chainId: number,
    rpcUrl: string,
    chainName?: string,
  ): Promise<bigint> {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    return client.getBlockNumber();
  }

  async getBlock(
    chainId: number,
    rpcUrl: string,
    blockNumber: bigint,
    chainName?: string,
  ) {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    return client.getBlock({ blockNumber });
  }

  /**
   * Resolve a block near targetTimestamp.
   * Uses recent block-time estimation (HyperEVM RPC rejects far-history heights).
   */
  async resolveBlockAtOrBefore(
    chainId: number,
    rpcUrl: string,
    targetTimestampSec: number,
    chainName?: string,
  ): Promise<bigint> {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const latest = await client.getBlockNumber();
    const latestBlock = await client.getBlock({ blockNumber: latest });
    const latestTs = Number(latestBlock.timestamp);

    if (latestTs <= targetTimestampSec) {
      return latest;
    }

    const sampleDistance =
      latest > 1000n ? 1000n : latest > 10n ? latest / 2n : 1n;
    const sampleNumber = latest - sampleDistance;
    const sampleBlock = await client.getBlock({ blockNumber: sampleNumber });
    const sampleTs = Number(sampleBlock.timestamp);
    const elapsed = Math.max(latestTs - sampleTs, 1);
    const secPerBlock = elapsed / Number(sampleDistance);
    const deltaSec = latestTs - targetTimestampSec;
    const estimatedBlocksBack = BigInt(
      Math.max(1, Math.ceil(deltaSec / secPerBlock)),
    );

    let candidate =
      latest > estimatedBlocksBack ? latest - estimatedBlocksBack : 0n;

    candidate = await this.findNearestAvailableBlock(
      chainId,
      rpcUrl,
      candidate,
      latest,
      chainName,
    );

    // Refine within a small window around the estimate (keeps RPC in available range).
    const window = 50_000n;
    let low = candidate > window ? candidate - window : 0n;
    let high = candidate + window > latest ? latest : candidate + window;
    low = await this.findNearestAvailableBlock(
      chainId,
      rpcUrl,
      low,
      latest,
      chainName,
    );

    let answer = low;
    while (low <= high) {
      const mid = (low + high) / 2n;
      try {
        const block = await client.getBlock({ blockNumber: mid });
        const ts = Number(block.timestamp);
        if (ts <= targetTimestampSec) {
          answer = mid;
          low = mid + 1n;
        } else {
          if (mid === 0n) break;
          high = mid - 1n;
        }
      } catch {
        // Skip unavailable mid toward head.
        low = mid + 1n;
      }
    }

    this.logger.log(
      `Resolved lookback block ${answer} for timestamp ${targetTimestampSec} on chain ${chainId}`,
    );
    return answer;
  }

  private async findNearestAvailableBlock(
    chainId: number,
    rpcUrl: string,
    preferred: bigint,
    latest: bigint,
    chainName?: string,
  ): Promise<bigint> {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    let candidate = preferred > latest ? latest : preferred;

    for (let i = 0; i < 30; i++) {
      try {
        await client.getBlock({ blockNumber: candidate });
        return candidate;
      } catch {
        const step = BigInt(2 ** Math.min(i, 16)) * 100n;
        candidate = candidate + step > latest ? latest : candidate + step;
      }
    }

    return latest;
  }

  async getTransferLogs(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
    chainName?: string,
  ): Promise<DecodedTransfer[]> {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const address = getAddress(tokenAddress) as Address;

    const logs = await client.getLogs({
      address,
      event: transferEvent,
      fromBlock,
      toBlock,
    });

    const blockNumbers = [
      ...new Set(logs.map((log) => log.blockNumber).filter(Boolean)),
    ] as bigint[];

    // Sequential fetches to avoid HyperEVM RPC "cu limit exceeded".
    const timestamps = new Map<string, Date>();
    for (const bn of blockNumbers) {
      const block = await client.getBlock({ blockNumber: bn });
      timestamps.set(bn.toString(), new Date(Number(block.timestamp) * 1000));
    }

    const decoded: DecodedTransfer[] = [];

    for (const log of logs) {
      const parsed = this.decodeTransfer(log);
      if (!parsed || log.blockNumber == null || log.blockHash == null) {
        continue;
      }

      decoded.push({
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionIndex: log.transactionIndex ?? 0,
        txHash: log.transactionHash as Hash,
        logIndex: log.logIndex ?? 0,
        from: parsed.from,
        to: parsed.to,
        value: parsed.value,
        blockTimestamp:
          timestamps.get(log.blockNumber.toString()) ?? new Date(0),
      });
    }

    decoded.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });

    return decoded;
  }

  /**
   * Transfers where `holderAddress` is `from` or `to`, inclusive of both blocks.
   * Chunked to the RPC range limit. Self-transfers are returned once.
   */
  async getHolderTransferLogs(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    holderAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
    chainName?: string,
  ): Promise<DecodedTransfer[]> {
    if (fromBlock > toBlock) {
      return [];
    }

    const holder = getAddress(holderAddress) as Address;
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const byEvent = new Map<string, DecodedTransfer>();
    let start = fromBlock;
    let chunks = 0;

    while (start <= toBlock) {
      const end =
        start + MAX_LOG_BLOCK_RANGE - 1n > toBlock
          ? toBlock
          : start + MAX_LOG_BLOCK_RANGE - 1n;
      const outgoing = await this.withLogRetry(
        `holder from-logs ${start}..${end}`,
        () =>
          this.fetchDecodedLogs(
            chainId,
            rpcUrl,
            tokenAddress,
            start,
            end,
            { from: holder },
            chainName,
          ),
      );
      const incoming = await this.withLogRetry(
        `holder to-logs ${start}..${end}`,
        () =>
          this.fetchDecodedLogs(
            chainId,
            rpcUrl,
            tokenAddress,
            start,
            end,
            { to: holder },
            chainName,
          ),
      );
      for (const log of [...outgoing, ...incoming]) {
        byEvent.set(`${log.txHash.toLowerCase()}:${log.logIndex}`, log);
      }
      chunks += 1;
      if (chunks % 25 === 0) {
        this.logger.log(
          `Holder ${holderAddress} log scan reached block ${end} / ${toBlock}`,
        );
      }
      start = end + 1n;
    }

    const decoded = [...byEvent.values()];
    const blockNumbers = [...new Set(decoded.map((log) => log.blockNumber))];
    const timestamps = new Map<string, Date>();
    for (const blockNumber of blockNumbers) {
      const block = await this.withLogRetry(`block ${blockNumber}`, () =>
        client.getBlock({ blockNumber }),
      );
      timestamps.set(
        blockNumber.toString(),
        new Date(Number(block.timestamp) * 1000),
      );
    }
    for (const log of decoded) {
      log.blockTimestamp =
        timestamps.get(log.blockNumber.toString()) ?? new Date(0);
    }

    decoded.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });
    return decoded;
  }

  /**
   * Decoded transfers in one inclusive range. Does not fetch block timestamps.
   * HyperEVM rejects ranges wider than 1000 blocks; the caller chunks.
   */
  async getTransferDeltasInRange(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
    chainName?: string,
  ): Promise<TransferDelta[]> {
    if (fromBlock > toBlock) {
      return [];
    }

    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const address = getAddress(tokenAddress) as Address;
    const logs = await client.getLogs({
      address,
      event: transferEvent,
      fromBlock,
      toBlock,
    });

    const transfers: TransferDelta[] = [];
    for (const log of logs) {
      const parsed = this.decodeTransfer(log);
      if (!parsed) {
        continue;
      }
      transfers.push(parsed);
    }
    return transfers;
  }

  private async fetchDecodedLogs(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
    args: { from: Address } | { to: Address },
    chainName?: string,
  ): Promise<DecodedTransfer[]> {
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const address = getAddress(tokenAddress) as Address;
    const logs = await client.getLogs({
      address,
      event: transferEvent,
      args,
      fromBlock,
      toBlock,
    });

    const decoded: DecodedTransfer[] = [];
    for (const log of logs) {
      const parsed = this.decodeTransfer(log);
      if (!parsed || log.blockNumber == null || log.blockHash == null) {
        continue;
      }
      decoded.push({
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionIndex: log.transactionIndex ?? 0,
        txHash: log.transactionHash as Hash,
        logIndex: log.logIndex ?? 0,
        from: parsed.from,
        to: parsed.to,
        value: parsed.value,
        blockTimestamp: new Date(0),
      });
    }
    return decoded;
  }

  private async withLogRetry<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const message = (err as Error).message?.toLowerCase() ?? "";
        const retryable =
          message.includes("cu limit") ||
          message.includes("too fast") ||
          message.includes("rate limit") ||
          message.includes("429") ||
          message.includes("unable to complete") ||
          message.includes("timeout") ||
          message.includes("econnreset") ||
          message.includes("etimedout");
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }
        const delay = Math.min(8000, 400 * 2 ** (attempt - 1));
        this.logger.warn(
          `${label} failed: ${(err as Error).message}; retry in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(label);
  }

  private decodeTransfer(
    log: Log,
  ): { from: string; to: string; value: bigint } | null {
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "Transfer") {
        return null;
      }

      const args = decoded.args as {
        from: Address;
        to: Address;
        value: bigint;
      };

      return {
        from: args.from.toLowerCase(),
        to: args.to.toLowerCase(),
        value: args.value,
      };
    } catch {
      return null;
    }
  }
}
