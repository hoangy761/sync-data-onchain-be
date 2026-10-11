import { parseRpcUrlList } from '../common/utils/rpc-url.util';

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
].join(',');

function parseTrustProxy(
  value: string | undefined,
  nodeEnv: string,
): boolean | number {
  const raw = (value ?? '').trim();
  if (!raw) {
    return nodeEnv === 'production' ? 1 : false;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return parseInt(raw, 10);
}

function parseOriginList(value: string | undefined): string[] {
  const seen = new Set<string>();
  const origins: string[] = [];
  for (const raw of (value ?? '').split(',')) {
    const origin = raw.trim();
    if (!origin || seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    origins.push(origin);
  }
  return origins;
}

export default () => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    port: parseInt(process.env.PORT ?? '3000', 10),
    corsOrigins: parseOriginList(
      process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS,
    ),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, nodeEnv),
    rateLimit: {
      ttlMs: parseInt(process.env.RATE_LIMIT_TTL_MS ?? '60000', 10),
      max: parseInt(process.env.RATE_LIMIT_MAX ?? '120', 10),
    },
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
      confirmationDepth: parseInt(
        process.env.SYNC_CONFIRMATION_DEPTH ?? '12',
        10,
      ),
      pollIntervalMs: parseInt(process.env.SYNC_POLL_INTERVAL_MS ?? '5000', 10),
      lookbackDays: parseInt(process.env.SYNC_LOOKBACK_DAYS ?? '7', 10),
      deployedAt: parseInt(process.env.DAY_APP_DEPLOY ?? '0', 10),
      retryMaxAttempts: parseInt(process.env.SYNC_RETRY_MAX_ATTEMPTS ?? '5', 10),
      retryBaseDelayMs: parseInt(
        process.env.SYNC_RETRY_BASE_DELAY_MS ?? '1000',
        10,
      ),
    },
  };
};
