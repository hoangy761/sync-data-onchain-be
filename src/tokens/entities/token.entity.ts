import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Chain } from '../../chains/entities/chain.entity';

@Entity({ name: 'tokens' })
export class Token {
  @PrimaryColumn({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @PrimaryColumn({ name: 'token_address', type: 'varchar', length: 42 })
  tokenAddress!: string;

  @ManyToOne(() => Chain, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'chain_id', referencedColumnName: 'chainId' })
  chain!: Chain;

  @Column({ type: 'varchar', length: 32, nullable: true })
  symbol!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  name!: string | null;

  @Column({ type: 'smallint', nullable: true })
  decimals!: number | null;

  @Column({ name: 'deployment_block', type: 'bigint' })
  deploymentBlock!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
