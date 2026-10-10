import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { BootstrapModule } from '../bootstrap/bootstrap.module';
import { TokenBalance } from '../balances/entities/token-balance.entity';
import { TokenBalanceHistory } from '../balances/entities/token-balance-history.entity';
import { ChainsModule } from '../chains/chains.module';
import { TokensModule } from '../tokens/tokens.module';
import { CheckpointService } from './checkpoint.service';
import { SyncCheckpoint } from './entities/sync-checkpoint.entity';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SyncWorker } from './sync.worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SyncCheckpoint,
      TokenBalance,
      TokenBalanceHistory,
    ]),
    TokensModule,
    ChainsModule,
    BlockchainModule,
    BootstrapModule,
  ],
  providers: [SyncService, CheckpointService, SyncWorker],
  controllers: [SyncController],
  exports: [SyncService, CheckpointService],
})
export class SyncModule {}
