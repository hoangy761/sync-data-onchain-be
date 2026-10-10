import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Erc20Reader } from '../blockchain/erc20.reader';
import { TransferLogReader } from '../blockchain/transfer-log.reader';
import { ChainsService } from '../chains/chains.service';
import { SyncCheckpoint } from '../sync/entities/sync-checkpoint.entity';
import { normalizeAddress } from '../common/utils/address.util';
import { Token } from './entities/token.entity';

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    @InjectRepository(Token)
    private readonly tokensRepo: Repository<Token>,
    @InjectRepository(SyncCheckpoint)
    private readonly checkpointsRepo: Repository<SyncCheckpoint>,
    private readonly chainsService: ChainsService,
    private readonly erc20Reader: Erc20Reader,
    private readonly transferLogReader: TransferLogReader,
    private readonly config: ConfigService,
  ) {}

  async seedDefaultIfEmpty(): Promise<Token | null> {
    const count = await this.tokensRepo.count();
    if (count > 0) {
      this.logger.log(`Tokens already seeded (${count} row(s)); skip token seed`);
      return null;
    }

    const chainId = this.config.get<number>('seed.chainId')!;
    const tokenAddress = normalizeAddress(
      this.config.get<string>('seed.tokenAddress')!,
    );
    const lookbackDays = this.config.get<number>('sync.lookbackDays')!;

    const chain = await this.chainsService.getEnabled(chainId);

    this.logger.log(
      `Verifying token ${tokenAddress} on ${chain.name} (${chain.chainId})`,
    );

    const metadata = await this.erc20Reader.readMetadata(
      chain.chainId,
      chain.rpcUrl,
      tokenAddress,
      chain.name,
    );

    const targetTs =
      Math.floor(Date.now() / 1000) - lookbackDays * 24 * 60 * 60;
    const startBlock = await this.transferLogReader.resolveBlockAtOrBefore(
      chain.chainId,
      chain.rpcUrl,
      targetTs,
      chain.name,
    );

    const token = this.tokensRepo.create({
      chainId: chain.chainId,
      tokenAddress,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      deploymentBlock: startBlock.toString(),
      enabled: true,
    });

    const checkpoint = this.checkpointsRepo.create({
      chainId: chain.chainId,
      tokenAddress,
      lastProcessedBlock: (startBlock > 0n ? startBlock - 1n : 0n).toString(),
      lastBlockHash: null,
    });

    await this.tokensRepo.manager.transaction(async (manager) => {
      await manager.save(token);
      await manager.save(checkpoint);
    });

    this.logger.log(
      `Seeded token ${metadata.symbol} (${tokenAddress}) on chain ${chain.chainId}, startBlock=${startBlock}`,
    );

    return token;
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepo.find({ order: { chainId: 'ASC', tokenAddress: 'ASC' } });
  }

  findEnabled(): Promise<Token[]> {
    return this.tokensRepo.find({
      where: { enabled: true },
      order: { chainId: 'ASC', tokenAddress: 'ASC' },
    });
  }

  async findOne(chainId: number, tokenAddress: string): Promise<Token> {
    const token = await this.tokensRepo.findOne({
      where: {
        chainId,
        tokenAddress: normalizeAddress(tokenAddress),
      },
    });
    if (!token) {
      throw new NotFoundException(
        `Token ${tokenAddress} on chain ${chainId} not found`,
      );
    }
    return token;
  }
}
