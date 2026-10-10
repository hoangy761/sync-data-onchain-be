import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BootstrapService } from '../bootstrap/bootstrap.service';
import { SyncService } from './sync.service';

@Injectable()
export class SyncWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly syncService: SyncService,
    private readonly bootstrapService: BootstrapService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrapService.ensureSeeded();

    const enabled = this.config.get<boolean>('sync.enabled');
    if (!enabled) {
      this.logger.log('SYNC_ENABLED=false; worker not started');
      return;
    }

    const interval = this.config.get<number>('sync.pollIntervalMs')!;
    this.logger.log(`Starting sync worker (interval=${interval}ms)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      await this.syncService.syncOnce();
    } catch (err) {
      this.logger.error(`Sync tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
