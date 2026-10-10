import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1740000000000 implements MigrationInterface {
  name = 'InitSchema1740000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chains (
        chain_id     INTEGER PRIMARY KEY,
        name         VARCHAR(64) NOT NULL,
        rpc_url      TEXT NOT NULL,
        enabled      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE tokens (
        chain_id          INTEGER NOT NULL,
        token_address     VARCHAR(42) NOT NULL,
        symbol            VARCHAR(32),
        name              VARCHAR(128),
        decimals          SMALLINT,
        deployment_block  BIGINT NOT NULL,
        enabled           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token_address),
        CONSTRAINT fk_tokens_chain
          FOREIGN KEY (chain_id) REFERENCES chains(chain_id) ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE TABLE token_balances (
        chain_id          INTEGER NOT NULL,
        token_address     VARCHAR(42) NOT NULL,
        holder_address    VARCHAR(42) NOT NULL,
        balance           NUMERIC(78, 0) NOT NULL,
        updated_block     BIGINT NOT NULL,
        updated_log_index INTEGER,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token_address, holder_address),
        CHECK (balance >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE token_balance_history (
        id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        chain_id          INTEGER NOT NULL,
        token_address     VARCHAR(42) NOT NULL,
        holder_address    VARCHAR(42) NOT NULL,
        block_number      BIGINT NOT NULL,
        block_hash        VARCHAR(66) NOT NULL,
        block_timestamp   TIMESTAMPTZ NOT NULL,
        transaction_index INTEGER NOT NULL,
        tx_hash           VARCHAR(66) NOT NULL,
        log_index         INTEGER NOT NULL,
        balance_before    NUMERIC(78, 0) NOT NULL,
        balance_after     NUMERIC(78, 0) NOT NULL,
        delta             NUMERIC(80, 0) NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_balance_history_event_holder
          UNIQUE (chain_id, tx_hash, log_index, holder_address)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_balance_history_holder_order
      ON token_balance_history (
        chain_id,
        token_address,
        holder_address,
        block_number DESC,
        transaction_index DESC,
        log_index DESC
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_balance_history_block
      ON token_balance_history (chain_id, token_address, block_number);
    `);

    await queryRunner.query(`
      CREATE TABLE sync_checkpoints (
        chain_id             INTEGER NOT NULL,
        token_address        VARCHAR(42) NOT NULL,
        last_processed_block BIGINT NOT NULL,
        last_block_hash      VARCHAR(66),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token_address)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sync_checkpoints;`);
    await queryRunner.query(`DROP TABLE IF EXISTS token_balance_history;`);
    await queryRunner.query(`DROP TABLE IF EXISTS token_balances;`);
    await queryRunner.query(`DROP TABLE IF EXISTS tokens;`);
    await queryRunner.query(`DROP TABLE IF EXISTS chains;`);
  }
}
