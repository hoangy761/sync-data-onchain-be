import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { envValidationSchema } from './config/validation';
import { DatabaseModule } from './database/database.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { ChainsModule } from './chains/chains.module';
import { TokensModule } from './tokens/tokens.module';
import { BalancesModule } from './balances/balances.module';
import { SyncModule } from './sync/sync.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    BlockchainModule,
    ChainsModule,
    TokensModule,
    BalancesModule,
    BootstrapModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
