import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'sync_checkpoints' })
export class SyncCheckpoint {
  @PrimaryColumn({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @PrimaryColumn({ name: 'token_address', type: 'varchar', length: 42 })
  tokenAddress!: string;

  @Column({ name: 'last_processed_block', type: 'bigint' })
  lastProcessedBlock!: string;

  @Column({ name: 'last_block_hash', type: 'varchar', length: 66, nullable: true })
  lastBlockHash!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
