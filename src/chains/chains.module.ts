import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { ChainRpcEndpoint } from './entities/chain-rpc-endpoint.entity';
import { Chain } from './entities/chain.entity';
import { ChainsService } from './chains.service';
import { ChainsController } from './chains.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Chain, ChainRpcEndpoint]),
    BlockchainModule,
  ],
  providers: [ChainsService],
  controllers: [ChainsController],
  exports: [ChainsService],
})
export class ChainsModule {}
