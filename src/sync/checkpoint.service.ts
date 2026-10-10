import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { normalizeAddress } from '../common/utils/address.util';
import { SyncCheckpoint } from './entities/sync-checkpoint.entity';

@Injectable()
export class CheckpointService {
  constructor(
    @InjectRepository(SyncCheckpoint)
    private readonly checkpointsRepo: Repository<SyncCheckpoint>,
  ) {}

  async get(
    chainId: number,
    tokenAddress: string,
  ): Promise<SyncCheckpoint> {
    const checkpoint = await this.checkpointsRepo.findOne({
      where: {
        chainId,
        tokenAddress: normalizeAddress(tokenAddress),
      },
    });
    if (!checkpoint) {
      throw new NotFoundException(
        `Checkpoint missing for ${tokenAddress} on chain ${chainId}`,
      );
    }
    return checkpoint;
  }

  async find(
    chainId: number,
    tokenAddress: string,
  ): Promise<SyncCheckpoint | null> {
    return this.checkpointsRepo.findOne({
      where: {
        chainId,
        tokenAddress: normalizeAddress(tokenAddress),
      },
    });
  }
}
