import { Injectable } from '@nestjs/common';
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type PublicClient,
  type Transport,
  type Chain as ViemChain,
} from 'viem';
import { rpcHost, uniqueRpcUrls } from '../common/utils/rpc-url.util';

const RATE_LIMIT_COOLDOWN_MS = 10_000;
const coolingUntil = new Map<string, number>();

/**
 * Zan reports CU / rate limits as JSON-RPC `-32003`. viem labels that code
 * `TransactionRejectedRpcError` and its default fallback transport refuses to
 * try the next URL. These failures are provider limits, so the next endpoint
 * should run.
 */
function isProviderFailure(error: Error): boolean {
  const details =
    'details' in error && typeof error.details === 'string' ? error.details : '';
  const text = `${error.message}\n${details}`.toLowerCase();
  if (
    text.includes('cu limit') ||
    text.includes('too fast') ||
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('fetch failed') ||
    text.includes('unable to complete') ||
    text.includes('cooling down')
  ) {
    return true;
  }
  const code = 'code' in error ? error.code : undefined;
  return code === -32002 || code === -32003 || code === -32005;
}

function httpWithCooldown(url: string): Transport {
  const inner = http(url, { timeout: 30_000, retryCount: 0 });
  return (params) => {
    const transport = inner(params);
    return {
      ...transport,
      async request(args) {
        const until = coolingUntil.get(url) ?? 0;
        if (Date.now() < until) {
          throw new Error(`RPC ${rpcHost(url)} is cooling down after a rate limit`);
        }
        try {
          return await transport.request(args);
        } catch (err) {
          if (isProviderFailure(err as Error)) {
            coolingUntil.set(url, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          }
          throw err;
        }
      },
    };
  };
}

@Injectable()
export class RpcClientFactory {
  private readonly clients = new Map<string, PublicClient>();
  private readonly endpoints = new Map<number, string[]>();

  /** Primary first, then database fallbacks. Replaces the list for this chain. */
  register(chainId: number, urls: string[]): void {
    const next = uniqueRpcUrls(urls);
    const previous = this.endpoints.get(chainId) ?? [];
    const changed = previous.join('\n') !== next.join('\n');
    this.endpoints.set(chainId, next);
    if (!changed) {
      return;
    }
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${chainId}:`)) {
        this.clients.delete(key);
      }
    }
  }

  getClient(chainId: number, rpcUrl: string, chainName = 'Custom'): PublicClient {
    const urls = uniqueRpcUrls([rpcUrl, ...(this.endpoints.get(chainId) ?? [])]);
    const key = `${chainId}:${urls.join('\n')}`;
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }

    const chain: ViemChain = defineChain({
      id: chainId,
      name: chainName,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: urls as [string, ...string[]] },
      },
    });

    const transports = urls.map((url) => httpWithCooldown(url));
    const transport =
      transports.length === 1
        ? transports[0]
        : fallback(transports, {
            rank: false,
            shouldThrow: (error) => {
              if (isProviderFailure(error)) {
                return false;
              }
              return error.message.toLowerCase().includes('execution reverted');
            },
          });

    const client = createPublicClient({
      chain,
      transport,
    });

    this.clients.set(key, client as PublicClient);
    return client as PublicClient;
  }
}
