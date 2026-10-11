# ERC-20 Holder Balance Indexer

NestJS service that indexes ERC-20 `Transfer` events into PostgreSQL and exposes Swagger APIs for balances, history, and sync status.

## Problem

Sync holder data for one ERC-20 token on one chain into this service's PostgreSQL database: the confirmed balance of an address, the balance change on each `Transfer`, and how far indexing has caught up.

## Approach

HyperEVM is the chain. Token `name`, `symbol`, and `decimals` are read on-chain. The start block is estimated from `SYNC_LOOKBACK_DAYS`, because the RPC rejects far-history block heights.

A worker then indexes `Transfer` logs up to `head - SYNC_CONFIRMATION_DEPTH`. Each range writes `token_balances`, `token_balance_history`, and `sync_checkpoints` in one transaction. Amounts stay `NUMERIC` and the API returns them as strings.

A restart does not scan from the seed block again. The worker reads `sync_checkpoints.last_processed_block` and continues at the next block. The checkpoint moves only after that transaction commits, so a crash mid-range retries the same range. History rows already stored are skipped, and the balance is not applied a second time.

`balanceOf` on this chain is reliable only at the current head. The balance endpoint returns `balanceOf(head)` minus the net `Transfer` delta after the confirmed head, then `holder_sync_tasks` fills that holder's history in the background.

Design detail is in [erc20-holder-balance-indexer-architecture.md](erc20-holder-balance-indexer-architecture.md).

## Stack

- NestJS + TypeORM + PostgreSQL
- `viem` for HyperEVM JSON-RPC
- Swagger at `/docs`

PostgreSQL is external. This repo does not start a database container.

## Local development

Requires Node.js 22 and a reachable PostgreSQL database.

```bash
cp .env.example .env
# Set DATABASE_*, HYPEREVM_RPC_URL, TOKEN_ADDRESS, and DAY_APP_DEPLOY

npm ci
npm run start:dev
```

Migrations run automatically on boot. With `NODE_ENV=development`, TypeORM also synchronizes the schema.

- API: `http://localhost:3000` (`PORT` in `.env`)
- Swagger: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`



## Environment

Copy `[.env.example](.env.example)`. Required values are validated at startup.


| Variable                               | Role                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PORT`                                 | Listen port. Default `3000`. Docker Compose overrides this to `9999`.                                  |
| `CORS_ORIGINS`                         | Comma-separated browser origins. Defaults to the Vite dev and preview origins.                         |
| `DATABASE_*`                           | PostgreSQL connection. All four fields are required.                                                   |
| `HYPEREVM_RPC_URL`                     | Primary RPC. Seeded into `chains` when that table is empty, then synced into `chain_rpc_endpoints`.    |
| `HYPEREVM_RPC_URL_FALLBACK`            | Optional comma-separated fallbacks, used when the primary RPC fails.                                   |
| `CHAIN_ID` / `CHAIN_NAME`              | Seed chain. Defaults: `999` / `HyperEVM`.                                                              |
| `TOKEN_ADDRESS`                        | Seed token. Metadata is read on-chain when `tokens` is empty.                                          |
| `DAY_APP_DEPLOY`                       | Unix seconds. Empty holder history starts at this time minus `SYNC_LOOKBACK_DAYS`. Required.           |
| `SYNC_ENABLED`                         | Set to `false` to skip the sync worker. Default `true`.                                                |
| `SYNC_BLOCK_RANGE`                     | `eth_getLogs` window. Prefer a smaller value (for example `100`) if the RPC returns rate-limit errors. |
| `SYNC_CONFIRMATION_DEPTH`              | Confirmed head is chain head minus this depth. Default `12`.                                           |
| `SYNC_LOOKBACK_DAYS`                   | How far back the first checkpoint is estimated. Default `7`.                                           |
| `SYNC_POLL_INTERVAL_MS`                | Worker poll interval.                                                                                  |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_MAX` | Shared limit per client IP. Defaults: `60000` ms / `120` requests. `/health` is excluded.              |
| `TRUST_PROXY`                          | Proxy hops used to read `X-Forwarded-For`. Unset: `1` in production, off otherwise.                    |




## Bootstrap

1. If `chains` is empty, seed HyperEVM from `CHAIN_ID`, `CHAIN_NAME`, and `HYPEREVM_RPC_URL`, including fallback URLs.
2. If `tokens` is empty, read `name`, `symbol`, and `decimals` for `TOKEN_ADDRESS`, estimate the start block as now minus `SYNC_LOOKBACK_DAYS`, then insert the token and checkpoint.
3. When `SYNC_ENABLED=true`, the worker indexes `Transfer` logs through the RPC URLs stored for that chain.

`tokens.chain_id` is required and references `chains.chain_id`. After seed, runtime RPC comes from the database, not from a hard-coded URL.

## Endpoints


| Method | Path                                                            | Description                                     |
| ------ | --------------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/health`                                                       | Liveness                                        |
| GET    | `/api/v1/chains`                                                | List chains                                     |
| GET    | `/api/v1/chains/:chainId`                                       | Chain detail                                    |
| GET    | `/api/v1/tokens`                                                | List tokens                                     |
| GET    | `/api/v1/tokens/:chainId/:tokenAddress`                         | Token metadata                                  |
| GET    | `/api/v1/tokens/:chainId/:tokenAddress/top-holders`             | Top 100 indexed holder balances, highest first  |
| GET    | `/api/v1/tokens/:chainId/:tokenAddress/holders/:holder/balance` | Balance at head minus `SYNC_CONFIRMATION_DEPTH` |
| GET    | `/api/v1/tokens/:chainId/:tokenAddress/holders/:holder/history` | Balance history                                 |
| GET    | `/api/v1/tokens/:chainId/:tokenAddress/sync-status`             | Sync progress                                   |


Amounts and block numbers are returned as strings.

Over the rate limit, the API returns **429** with `Retry-After` and `X-RateLimit-`* headers. In production the process sits behind a reverse proxy, so that proxy must forward the client IP. Otherwise every caller shares one bucket.

## Notes

- HyperEVM RPC rejects far-history block heights. Lookback uses a recent block-time estimate.
- HyperEVM `balanceOf` is only reliable at the current head. A missing holder balance is `balance(head)` minus the net `Transfer` delta after the checkpoint. That scan is cached and resumed, at most `SYNC_BLOCK_RANGE` blocks per `eth_getLogs`.
- Admin APIs to add a chain, a token, or a custom sync start are out of scope.



## Deploy

`docker-compose.yml` runs the API only. Postgres must already exist and be reachable from the container via `DATABASE_*`.

**1. Build and push:**

```bash
docker build --platform linux/amd64 --target production -t hoangy761/sync-data-onchain-be:latest .
docker push hoangy761/sync-data-onchain-be:latest
```

**2. On the VM:** copy `docker-compose.yml` and create `.env` from `[.env.example](.env.example)`. Point `DATABASE_`* at the existing database. `PORT` in that file is ignored: Compose sets the container port to `9999`.

**3. Run:**

```bash
docker compose pull && docker compose up -d && docker compose logs -f
```

The API is published on the host at `http://127.0.0.1:19999` (container `9999`). It is not bound to the public interface. Put nginx or Caddy in front for HTTPS.

**Update:**

```bash
docker compose pull && docker compose up -d && docker compose logs -f
```

