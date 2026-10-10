import { EntityManager } from 'typeorm';

/** Serializes balance writes for one token across the sync worker and holder backfill. */
export async function lockTokenWrites(
  manager: EntityManager,
  chainId: number,
  tokenAddress: string,
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2))`, [
    chainId,
    tokenAddress.toLowerCase(),
  ]);
}
