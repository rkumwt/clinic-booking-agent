import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Env } from '../config/env';
import { SlotsService } from './slots.service';

@Injectable()
export class SlotsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(SlotsJobs.name);
  private readonly enabled: boolean;

  constructor(
    private readonly slots: SlotsService,
    config: ConfigService<Env, true>,
  ) {
    // Tests drive these methods directly so results are deterministic.
    this.enabled = config.get('NODE_ENV', { infer: true }) !== 'test';
  }

  async onApplicationBootstrap() {
    if (this.enabled) await this.generate();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async releaseExpiredHolds() {
    if (!this.enabled) return;
    await this.slots.releaseExpiredHolds().catch((err) => this.logger.error(err));
  }

  // Hourly rather than nightly: the job is idempotent, and this way the
  // booking horizon recovers quickly after any downtime.
  @Cron(CronExpression.EVERY_HOUR)
  async generate() {
    if (!this.enabled) return;
    try {
      const result = await this.slots.syncAllDoctors();
      this.logger.log(`Slot generation: +${result.created} / -${result.removed}, ${result.conflicts} conflict(s)`);
    } catch (err) {
      this.logger.error(err);
    }
  }
}
