import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'chain_rpc_endpoints' })
@Unique('uq_chain_rpc_endpoints_chain_url', ['chainId', 'url'])
@Index('idx_chain_rpc_endpoints_chain', ['chainId', 'sortOrder'])
export class ChainRpcEndpoint {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @Column({ type: 'text' })
  url!: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
