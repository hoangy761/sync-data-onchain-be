import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChainRpcEndpoints1740000001000 implements MigrationInterface {
  name = 'ChainRpcEndpoints1740000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chain_rpc_endpoints (
        id          SERIAL PRIMARY KEY,
        chain_id    INTEGER NOT NULL,
        url         TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_chain_rpc_endpoints_chain
          FOREIGN KEY (chain_id) REFERENCES chains(chain_id) ON DELETE CASCADE,
        CONSTRAINT uq_chain_rpc_endpoints_chain_url
          UNIQUE (chain_id, url)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chain_rpc_endpoints_chain
      ON chain_rpc_endpoints (chain_id, sort_order);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS chain_rpc_endpoints;`);
  }
}
