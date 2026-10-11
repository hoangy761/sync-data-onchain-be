import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { ChainRpcEndpoint } from '../chains/entities/chain-rpc-endpoint.entity';
import { Chain } from '../chains/entities/chain.entity';
import { Token } from '../tokens/entities/token.entity';
import { HolderSyncTask } from '../balances/entities/holder-sync-task.entity';
import { TokenBalance } from '../balances/entities/token-balance.entity';
import { TokenBalanceHistory } from '../balances/entities/token-balance-history.entity';
import { SyncCheckpoint } from '../sync/entities/sync-checkpoint.entity';
import { ChainRpcEndpoints1740000001000 } from './migrations/1740000001000-ChainRpcEndpoints';
import { HolderSyncTasks1740000002000 } from './migrations/1740000002000-HolderSyncTasks';
import { TokenBalanceRankIndex1740000003000 } from './migrations/1740000003000-TokenBalanceRankIndex';
import { InitSchema1740000000000 } from './migrations/1740000000000-InitSchema';

loadEnv();

export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'postgres',
  database: process.env.DATABASE_NAME ?? 'indexer',
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
    TokenBalanceRankIndex1740000003000,
  ],
  synchronize: false,
});
