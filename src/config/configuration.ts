import { parseRpcUrlList } from '../common/utils/rpc-url.util';

export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'postgres',
    name: process.env.DATABASE_NAME ?? 'indexer',
  },
  seed: {
    chainId: parseInt(process.env.CHAIN_ID ?? '999', 10),
    chainName: process.env.CHAIN_NAME ?? 'HyperEVM',
    rpcUrl: process.env.HYPEREVM_RPC_URL ?? '',
    rpcFallbackUrls: parseRpcUrlList(process.env.HYPEREVM_RPC_URL_FALLBACK),
    tokenAddress: (process.env.TOKEN_ADDRESS ?? '').toLowerCase(),
  },
  sync: {
    enabled: (process.env.SYNC_ENABLED ?? 'true').toLowerCase() !== 'false',
    blockRange: parseInt(process.env.SYNC_BLOCK_RANGE ?? '500', 10),
    confirmationDepth: parseInt(process.env.SYNC_CONFIRMATION_DEPTH ?? '12', 10),
    pollIntervalMs: parseInt(process.env.SYNC_POLL_INTERVAL_MS ?? '5000', 10),
    lookbackDays: parseInt(process.env.SYNC_LOOKBACK_DAYS ?? '7', 10),
    deployedAt: parseInt(process.env.DAY_APP_DEPLOY ?? '0', 10),
    retryMaxAttempts: parseInt(process.env.SYNC_RETRY_MAX_ATTEMPTS ?? '5', 10),
    retryBaseDelayMs: parseInt(process.env.SYNC_RETRY_BASE_DELAY_MS ?? '1000', 10),
  },
});
