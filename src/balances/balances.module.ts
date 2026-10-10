import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { ChainsModule } from '../chains/chains.module';
import { TokensModule } from '../tokens/tokens.module';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { HolderSyncTask } from './entities/holder-sync-task.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { TokenBalanceHistory } from './entities/token-balance-history.entity';
import { HolderBackfillService } from './holder-backfill.service';
import { HolderSyncScheduler } from './holder-sync.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([TokenBalanceHistory, TokenBalance, HolderSyncTask]),
    TokensModule,
    ChainsModule,
    BlockchainModule,
  ],
  providers: [BalancesService, HolderBackfillService, HolderSyncScheduler],
  controllers: [BalancesController],
  exports: [BalancesService],
})
export class BalancesModule {}
