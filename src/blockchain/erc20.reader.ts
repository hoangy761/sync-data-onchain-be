import { Injectable, Logger } from '@nestjs/common';
import { type Address, getAddress, isAddress } from 'viem';
import { erc20Abi } from './abi/erc20.abi';
import { RpcClientFactory } from './rpc-client.factory';

export interface Erc20Metadata {
  name: string;
  symbol: string;
  decimals: number;
}

@Injectable()
export class Erc20Reader {
  private readonly logger = new Logger(Erc20Reader.name);

  constructor(private readonly rpcClientFactory: RpcClientFactory) {}

  async readMetadata(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    chainName?: string,
  ): Promise<Erc20Metadata> {
    if (!isAddress(tokenAddress)) {
      throw new Error(`Invalid token address: ${tokenAddress}`);
    }

    const address = getAddress(tokenAddress) as Address;
    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);

    this.logger.log(
      `Verifying ERC-20 metadata on chain ${chainId} for ${address}`,
    );

    const [name, symbol, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: 'name',
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    ]);

    return {
      name: String(name),
      symbol: String(symbol),
      decimals: Number(decimals),
    };
  }

  async balanceOf(
    chainId: number,
    rpcUrl: string,
    tokenAddress: string,
    holderAddress: string,
    blockNumber?: bigint,
    chainName?: string,
  ): Promise<bigint> {
    if (!isAddress(tokenAddress) || !isAddress(holderAddress)) {
      throw new Error('Invalid token or holder address for balanceOf');
    }

    const client = this.rpcClientFactory.getClient(chainId, rpcUrl, chainName);
    const balance = await client.readContract({
      address: getAddress(tokenAddress) as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(holderAddress) as Address],
      ...(blockNumber != null ? { blockNumber } : {}),
    });

    return BigInt(balance);
  }
}
