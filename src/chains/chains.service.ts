import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RpcClientFactory } from "../blockchain/rpc-client.factory";
import {
  isHttpRpcUrl,
  rpcHost,
  uniqueRpcUrls,
} from "../common/utils/rpc-url.util";
import { ChainRpcEndpoint } from "./entities/chain-rpc-endpoint.entity";
import { Chain } from "./entities/chain.entity";

@Injectable()
export class ChainsService {
  private readonly logger = new Logger(ChainsService.name);
  private readonly envEndpointsSynced = new Set<number>();
  private readonly registeredOrder = new Map<number, string>();

  constructor(
    @InjectRepository(Chain)
    private readonly chainsRepo: Repository<Chain>,
    @InjectRepository(ChainRpcEndpoint)
    private readonly endpointsRepo: Repository<ChainRpcEndpoint>,
    private readonly config: ConfigService,
    private readonly rpcClientFactory: RpcClientFactory,
  ) {}

  async seedDefaultIfEmpty(): Promise<Chain> {
    const count = await this.chainsRepo.count();
    if (count > 0) {
      const chainId = this.config.get<number>("seed.chainId")!;
      const existing = await this.chainsRepo.findOne({ where: { chainId } });
      if (!existing) {
        throw new Error(
          `Chains table is not empty but seed chain ${chainId} is missing`,
        );
      }
      this.logger.log(
        `Chains already seeded (${count} row(s)); skip chain seed`,
      );
      await this.syncRpcEndpoints(existing);
      return existing;
    }

    const chainId = this.config.getOrThrow<number>("seed.chainId");
    const name = this.config.getOrThrow<string>("seed.chainName");
    const rpcUrl = this.config.get<string>("seed.rpcUrl");

    if (!rpcUrl) {
      throw new Error("HYPEREVM_RPC_URL is required to seed default chain");
    }

    const chain = this.chainsRepo.create({
      chainId,
      name,
      rpcUrl,
      enabled: true,
    });
    const saved = await this.chainsRepo.save(chain);
    this.logger.log(`Seeded chain ${saved.name} (id=${saved.chainId})`);
    await this.syncRpcEndpoints(saved);
    return saved;
  }

  async findAll(): Promise<Chain[]> {
    const chains = await this.chainsRepo.find({ order: { chainId: "ASC" } });
    for (const chain of chains) {
      await this.syncRpcEndpoints(chain);
    }
    return chains;
  }

  async findOne(chainId: number): Promise<Chain> {
    const chain = await this.chainsRepo.findOne({ where: { chainId } });
    if (!chain) {
      throw new NotFoundException(`Chain ${chainId} not found`);
    }
    await this.syncRpcEndpoints(chain);
    return chain;
  }

  async getEnabled(chainId: number): Promise<Chain> {
    const chain = await this.chainsRepo.findOne({
      where: { chainId, enabled: true },
    });
    if (!chain) {
      throw new NotFoundException(`Enabled chain ${chainId} not found`);
    }
    await this.syncRpcEndpoints(chain);
    return chain;
  }

  /**
   * Keeps `chain_rpc_endpoints` aligned with the primary URL plus
   * `HYPEREVM_RPC_URL_FALLBACK`. URLs removed from env are disabled.
   */
  private async syncRpcEndpoints(chain: Chain): Promise<void> {
    if (!this.envEndpointsSynced.has(chain.chainId)) {
      const fallbacks = this.config.get<string[]>("seed.rpcFallbackUrls") ?? [];
      const candidates = uniqueRpcUrls([chain.rpcUrl, ...fallbacks]).filter(
        (url) => {
          if (isHttpRpcUrl(url)) {
            return true;
          }
          this.logger.warn(
            `Skipping invalid RPC URL for chain ${chain.chainId} (${rpcHost(url)})`,
          );
          return false;
        },
      );
      await this.endpointsRepo.query(
        `UPDATE chain_rpc_endpoints
         SET enabled = FALSE
         WHERE chain_id = $1
           AND NOT (url = ANY($2::text[]))`,
        [chain.chainId, candidates],
      );
      for (const [index, url] of candidates.entries()) {
        await this.endpointsRepo.query(
          `INSERT INTO chain_rpc_endpoints (chain_id, url, sort_order, enabled)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (chain_id, url)
           DO UPDATE SET enabled = TRUE, sort_order = EXCLUDED.sort_order`,
          [chain.chainId, url, index],
        );
      }
      this.envEndpointsSynced.add(chain.chainId);
    }

    const rows = await this.endpointsRepo.find({
      where: { chainId: chain.chainId, enabled: true },
      order: { sortOrder: "ASC", id: "ASC" },
    });
    const urls = uniqueRpcUrls(
      rows.length > 0 ? rows.map((row) => row.url) : [chain.rpcUrl],
    );
    const signature = urls.join("\n");
    this.rpcClientFactory.register(chain.chainId, urls);
    if (this.registeredOrder.get(chain.chainId) === signature) {
      return;
    }
    this.registeredOrder.set(chain.chainId, signature);
    this.logger.log(
      `Chain ${chain.chainId} RPC order: ${urls.map(rpcHost).join(" -> ")}`,
    );
  }
}
