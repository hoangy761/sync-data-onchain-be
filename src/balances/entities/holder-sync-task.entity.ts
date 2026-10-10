import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type HolderSyncTaskStatus = 'pending' | 'running' | 'done' | 'failed';

@Entity({ name: 'holder_sync_tasks' })
@Unique('uq_holder_sync_tasks_holder', ['chainId', 'tokenAddress', 'holderAddress'])
@Index('idx_holder_sync_tasks_status', ['status', 'createdAt'])
export class HolderSyncTask {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @Column({ name: 'token_address', type: 'varchar', length: 42 })
  tokenAddress!: string;

  @Column({ name: 'holder_address', type: 'varchar', length: 42 })
  holderAddress!: string;

  @Column({ name: 'target_block', type: 'bigint' })
  targetBlock!: string;

  @Column({ name: 'confirmed_balance', type: 'numeric', precision: 78, scale: 0 })
  confirmedBalance!: string;

  /**
   * Cursor block for this attempt. Starts at the first block to scan and
   * advances to the block after the last history row written. A restart sets
   * `nextBlock` back here.
   */
  @Column({ name: 'scan_from_block', type: 'bigint' })
  scanFromBlock!: string;

  /** Next block to read. Inclusive start of the following chunk. */
  @Column({ name: 'next_block', type: 'bigint' })
  nextBlock!: string;

  @Column({
    name: 'start_balance',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  startBalance!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: HolderSyncTaskStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
