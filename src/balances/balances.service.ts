import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { normalizeAddress } from '../common/utils/address.util';
import { formatTokenAmount } from '../common/utils/decimal.util';
import { Token } from '../tokens/entities/token.entity';
import { TokensService } from '../tokens/tokens.service';
import { TokenBalanceHistory } from './entities/token-balance-history.entity';
import { HolderBackfillService } from './holder-backfill.service';

@Injectable()
export class BalancesService {
  constructor(
    @InjectRepository(TokenBalanceHistory)
    private readonly historyRepo: Repository<TokenBalanceHistory>,
    private readonly tokensService: TokensService,
    private readonly holderBackfill: HolderBackfillService,
    private readonly config: ConfigService,
  ) {}

  async getBalance(
    chainId: number,
    tokenAddress: string,
    holderAddress: string,
  ) {
    const token = await this.tokensService.findOne(chainId, tokenAddress);
    const holder = normalizeAddress(holderAddress);
    const confirmed = await this.holderBackfill.readConfirmed(token, holder);

    return this.toBalanceDto(
      token,
      {
        holderAddress: holder,
        balance: confirmed.balance.toString(),
        updatedBlock: confirmed.blockNumber.toString(),
      },
      'confirmed',
    );
  }

  async getHistory(
    chainId: number,
    tokenAddress: string,
    holderAddress: string,
    limit = 50,
    cursor?: string,
  ) {
    const token = await this.tokensService.findOne(chainId, tokenAddress);
    const holder = normalizeAddress(holderAddress);
    const take = Math.min(Math.max(limit, 1), 200);

    const qb = this.historyRepo
      .createQueryBuilder('h')
      .where('h.chain_id = :chainId', { chainId })
      .andWhere('h.token_address = :tokenAddress', {
        tokenAddress: token.tokenAddress,
      })
      .andWhere('h.holder_address = :holder', { holder })
      .orderBy('h.block_number', 'DESC')
      .addOrderBy('h.transaction_index', 'DESC')
      .addOrderBy('h.log_index', 'DESC')
      .take(take + 1);

    if (cursor) {
      const parsed = this.parseCursor(cursor);
      qb.andWhere(
        `(h.block_number, h.transaction_index, h.log_index) < (:bn, :ti, :li)`,
        {
          bn: parsed.blockNumber,
          ti: parsed.transactionIndex,
          li: parsed.logIndex,
        },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items[items.length - 1];

    const historyItems = items.map((h) => ({
      blockNumber: h.blockNumber,
      timestamp: h.blockTimestamp.toISOString(),
      txHash: h.txHash,
      logIndex: h.logIndex,
      deltaRaw: h.delta,
      balanceBeforeRaw: h.balanceBefore,
      balanceAfterRaw: h.balanceAfter,
    }));

    return {
      items: historyItems,
      nextCursor:
        hasMore && last
          ? this.encodeCursor(
              last.blockNumber,
              last.transactionIndex,
              last.logIndex,
            )
          : null,
      message:
        historyItems.length === 0 && !cursor
          ? this.emptyHistoryMessage()
          : null,
    };
  }

  private emptyHistoryMessage(): string {
    const deployedAt = this.config.get<number>('sync.deployedAt') ?? 0;
    const lookbackDays = this.config.get<number>('sync.lookbackDays') ?? 1;
    const sinceSeconds = deployedAt - lookbackDays * 24 * 60 * 60;
    const since = new Date(sinceSeconds * 1000).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `No transactions since ${since}.`;
  }

  private toBalanceDto(
    token: Token,
    row: { holderAddress: string; balance: string; updatedBlock: string | null },
    balanceSource: 'confirmed',
  ) {
    const decimals = token.decimals ?? 0;
    return {
      chainId: token.chainId,
      tokenAddress: token.tokenAddress,
      holderAddress: row.holderAddress,
      balanceRaw: row.balance,
      decimals,
      balanceFormatted: formatTokenAmount(row.balance, decimals),
      updatedBlock: row.updatedBlock,
      balanceSource,
    };
  }

  private encodeCursor(
    blockNumber: string,
    transactionIndex: number,
    logIndex: number,
  ): string {
    return Buffer.from(
      JSON.stringify({ blockNumber, transactionIndex, logIndex }),
    ).toString('base64url');
  }

  private parseCursor(cursor: string): {
    blockNumber: string;
    transactionIndex: number;
    logIndex: number;
  } {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as {
        blockNumber: string;
        transactionIndex: number;
        logIndex: number;
      };
      if (
        parsed.blockNumber == null ||
        parsed.transactionIndex == null ||
        parsed.logIndex == null
      ) {
        throw new Error('incomplete');
      }
      return parsed;
    } catch {
      throw new NotFoundException('Invalid history cursor');
    }
  }
}
