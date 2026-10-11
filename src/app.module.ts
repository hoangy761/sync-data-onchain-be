import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // One bucket per client IP for the whole API, not per route.
        generateKey: (_context, tracker, throttlerName) =>
          `${throttlerName}:${tracker}`,
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('rateLimit.ttlMs') ?? 60_000,
            limit: config.get<number>('rateLimit.max') ?? 120,
          },
        ],
      }),
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
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
