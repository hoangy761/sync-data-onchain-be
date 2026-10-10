import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'token_balances' })
export class TokenBalance {
  @PrimaryColumn({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @PrimaryColumn({ name: 'token_address', type: 'varchar', length: 42 })
  tokenAddress!: string;

  @PrimaryColumn({ name: 'holder_address', type: 'varchar', length: 42 })
  holderAddress!: string;

  @Column({ type: 'numeric', precision: 78, scale: 0 })
  balance!: string;

  @Column({ name: 'updated_block', type: 'bigint' })
  updatedBlock!: string;

  @Column({ name: 'updated_log_index', type: 'int', nullable: true })
  updatedLogIndex!: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
