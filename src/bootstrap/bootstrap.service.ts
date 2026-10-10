import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ChainsService } from '../chains/chains.service';
import { TokensService } from '../tokens/tokens.service';

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);
  private seedPromise: Promise<void> | null = null;

  constructor(
    private readonly chainsService: ChainsService,
    private readonly tokensService: TokensService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSeeded();
  }

  ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = this.runSeed();
    }
    return this.seedPromise;
  }

  private async runSeed(): Promise<void> {
    this.logger.log('Running bootstrap seed...');
    await this.chainsService.seedDefaultIfEmpty();
    await this.tokensService.seedDefaultIfEmpty();
    this.logger.log('Bootstrap seed complete');
  }
}
