import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChainRpcEndpoint } from "../chains/entities/chain-rpc-endpoint.entity";
import { Chain } from "../chains/entities/chain.entity";
import { Token } from "../tokens/entities/token.entity";
import { HolderSyncTask } from "../balances/entities/holder-sync-task.entity";
import { TokenBalance } from "../balances/entities/token-balance.entity";
import { TokenBalanceHistory } from "../balances/entities/token-balance-history.entity";
import { SyncCheckpoint } from "../sync/entities/sync-checkpoint.entity";
import { ChainRpcEndpoints1740000001000 } from "./migrations/1740000001000-ChainRpcEndpoints";
import { HolderSyncTasks1740000002000 } from "./migrations/1740000002000-HolderSyncTasks";
import { InitSchema1740000000000 } from "./migrations/1740000000000-InitSchema";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        host: config.get<string>("database.host"),
        port: config.get<number>("database.port"),
        username: config.get<string>("database.user"),
        password: config.get<string>("database.password"),
        database: config.get<string>("database.name"),
        entities: [
          Chain,
          ChainRpcEndpoint,
          Token,
          TokenBalance,
          TokenBalanceHistory,
          HolderSyncTask,
          SyncCheckpoint,
        ],
        migrations: [
          InitSchema1740000000000,
          ChainRpcEndpoints1740000001000,
          HolderSyncTasks1740000002000,
        ],
        migrationsRun: true,
        synchronize: process.env.NODE_ENV === "development",
        logging: ["error"],
      }),
    }),
  ],
})
export class DatabaseModule {}
