import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { ChainsModule } from '../chains/chains.module';
import { SyncCheckpoint } from '../sync/entities/sync-checkpoint.entity';
import { Token } from './entities/token.entity';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Token, SyncCheckpoint]),
    ChainsModule,
    BlockchainModule,
  ],
  providers: [TokensService],
  controllers: [TokensController],
  exports: [TokensService],
})
export class TokensModule {}
