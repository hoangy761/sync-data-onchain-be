# ERC-20 Holder Balance Indexer

NestJS service that indexes ERC-20 `Transfer` events into PostgreSQL and exposes Swagger APIs for balances, history, and sync status.

## Stack

- NestJS + TypeORM + PostgreSQL
- `viem` for HyperEVM JSON-RPC
- Swagger at `/docs`

## Quick start

```bash
# 1) Start Postgres
docker compose up -d

# 2) Install deps
npm install --legacy-peer-deps

# 3) Copy env (or use existing .env)
cp .env.example .env

# 4) Run (migrations run automatically on boot)
npm run start:dev
```

- API: `http://localhost:3000`
- Swagger: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

## Bootstrap behavior

1. If `chains` is empty → seed **HyperEVM** from `CHAIN_ID`, `CHAIN_NAME`, `HYPEREVM_RPC_URL`.
2. If `tokens` is empty → verify `TOKEN_ADDRESS` on-chain (`name`, `symbol`, `decimals` via viem), resolve start block ≈ **now − SYNC_LOOKBACK_DAYS**, insert token + checkpoint.
3. Sync worker (when `SYNC_ENABLED=true`) indexes Transfer logs using `chains.rpc_url`.

`tokens.chain_id` is required and references `chains.chain_id`.

## Main endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/api/v1/chains` | List chains |
| GET | `/api/v1/chains/:chainId` | Chain detail |
| GET | `/api/v1/tokens` | List tokens |
| GET | `/api/v1/tokens/:chainId/:tokenAddress` | Token metadata |
| GET | `/api/v1/tokens/:chainId/:tokenAddress/holders/:holder/balance` | Balance at head − `SYNC_CONFIRMATION_DEPTH` |
| GET | `/api/v1/tokens/:chainId/:tokenAddress/holders/:holder/history` | Balance history |
| GET | `/api/v1/tokens/:chainId/:tokenAddress/sync-status` | Sync progress |

## Notes

- `tokens.chain_id` is required and FK → `chains.chain_id`.
- Runtime RPC comes from the `chains` table after seed (not hard-coded from env).
- Amounts and block numbers are returned as strings.
- HyperEVM RPC rejects far-history block heights; lookback uses recent block-time estimation.
- HyperEVM `balanceOf` is only reliable at the current head (any other block returns 0). A missing holder balance is `balance(head) - net Transfer delta after the checkpoint`. That log scan is cached and resumed (max 1000 blocks per `eth_getLogs`).
- Admin APIs to add chain/token and custom sync start time are intentionally out of MVP scope.
- Prefer smaller `SYNC_BLOCK_RANGE` (e.g. 100) if the RPC returns rate-limit / CU errors.
