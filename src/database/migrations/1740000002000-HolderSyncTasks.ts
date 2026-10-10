import { MigrationInterface, QueryRunner } from 'typeorm';

export class HolderSyncTasks1740000002000 implements MigrationInterface {
  name = 'HolderSyncTasks1740000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS holder_sync_tasks (
        id                SERIAL PRIMARY KEY,
        chain_id          INTEGER NOT NULL,
        token_address     VARCHAR(42) NOT NULL,
        holder_address    VARCHAR(42) NOT NULL,
        target_block      BIGINT NOT NULL,
        confirmed_balance NUMERIC(78, 0) NOT NULL,
        scan_from_block   BIGINT NOT NULL,
        next_block        BIGINT NOT NULL,
        start_balance     NUMERIC(78, 0),
        status            VARCHAR(16) NOT NULL,
        last_error        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_holder_sync_tasks_holder
          UNIQUE (chain_id, token_address, holder_address)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_holder_sync_tasks_status
      ON holder_sync_tasks (status, created_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS holder_sync_tasks;`);
  }
}
