import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),
  DATABASE_NAME: Joi.string().required(),

  HYPEREVM_RPC_URL: Joi.string().uri().required(),
  HYPEREVM_RPC_URL_FALLBACK: Joi.string().allow('').optional(),
  CHAIN_ID: Joi.number().integer().required(),
  CHAIN_NAME: Joi.string().default('HyperEVM'),
  TOKEN_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),

  SYNC_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  SYNC_BLOCK_RANGE: Joi.number().integer().min(1).default(500),
  SYNC_CONFIRMATION_DEPTH: Joi.number().integer().min(0).default(12),
  SYNC_POLL_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),
  SYNC_LOOKBACK_DAYS: Joi.number().integer().min(1).default(7),
  DAY_APP_DEPLOY: Joi.number().integer().positive().required(),
  SYNC_RETRY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  SYNC_RETRY_BASE_DELAY_MS: Joi.number().integer().min(100).default(1000),
});
