import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'chains' })
export class Chain {
  @PrimaryColumn({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ name: 'rpc_url', type: 'text' })
  rpcUrl!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
