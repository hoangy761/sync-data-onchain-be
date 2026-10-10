import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HolderBackfillService } from './holder-backfill.service';

@Injectable()
export class HolderSyncScheduler {
  private readonly logger = new Logger(HolderSyncScheduler.name);
  private ticking = false;

  constructor(private readonly holderBackfill: HolderBackfillService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.holderBackfill.processScheduledChunk();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Holder sync tick failed: ${message}`);
    } finally {
      this.ticking = false;
    }
  }
}
