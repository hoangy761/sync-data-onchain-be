import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'token_balance_history' })
@Unique('uq_balance_history_event_holder', [
  'chainId',
  'txHash',
  'logIndex',
  'holderAddress',
])
@Index('idx_balance_history_holder_order', [
  'chainId',
  'tokenAddress',
  'holderAddress',
  'blockNumber',
  'transactionIndex',
  'logIndex',
])
@Index('idx_balance_history_block', ['chainId', 'tokenAddress', 'blockNumber'])
export class TokenBalanceHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @Column({ name: 'token_address', type: 'varchar', length: 42 })
  tokenAddress!: string;

  @Column({ name: 'holder_address', type: 'varchar', length: 42 })
  holderAddress!: string;

  @Column({ name: 'block_number', type: 'bigint' })
  blockNumber!: string;

  @Column({ name: 'block_hash', type: 'varchar', length: 66 })
  blockHash!: string;

  @Column({ name: 'block_timestamp', type: 'timestamptz' })
  blockTimestamp!: Date;

  @Column({ name: 'transaction_index', type: 'int' })
  transactionIndex!: number;

  @Column({ name: 'tx_hash', type: 'varchar', length: 66 })
  txHash!: string;

  @Column({ name: 'log_index', type: 'int' })
  logIndex!: number;

  @Column({ name: 'balance_before', type: 'numeric', precision: 78, scale: 0 })
  balanceBefore!: string;

  @Column({ name: 'balance_after', type: 'numeric', precision: 78, scale: 0 })
  balanceAfter!: string;

  @Column({ type: 'numeric', precision: 80, scale: 0 })
  delta!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
