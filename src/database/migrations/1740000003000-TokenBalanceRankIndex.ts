import { MigrationInterface, QueryRunner } from 'typeorm';

export class TokenBalanceRankIndex1740000003000 implements MigrationInterface {
  name = 'TokenBalanceRankIndex1740000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_token_balances_rank
      ON token_balances (chain_id, token_address, balance DESC, holder_address)
      WHERE balance > 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_token_balances_rank;`);
  }
}
