import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.module';

export type LockResult = 'acquired' | 'owned' | 'taken' | 'unavailable';

// Compare-and-delete, so a holder can only release its own lock.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/**
 * Redis is the fast path: when two people tap the same slot, the loser is
 * turned away by a single SET NX without touching Postgres. It is NOT the
 * source of truth. If Redis is down we return 'unavailable' and the caller
 * falls through to the conditional UPDATE in Postgres, which is always correct.
 */
@Injectable()
export class SlotLockService {
  private readonly logger = new Logger(SlotLockService.name);

  constructor(private readonly redis: RedisService) {}

  private key(slotId: string) {
    return `hold:slot:${slotId}`;
  }

  async acquire(slotId: string, holderKey: string, ttlSeconds: number): Promise<LockResult> {
    try {
      const set = await this.redis.client.set(this.key(slotId), holderKey, 'EX', ttlSeconds, 'NX');
      if (set === 'OK') return 'acquired';
      const owner = await this.redis.client.get(this.key(slotId));
      return owner === holderKey ? 'owned' : 'taken';
    } catch (err) {
      this.logger.warn(`Redis unavailable, falling back to database only: ${(err as Error).message}`);
      return 'unavailable';
    }
  }

  async release(slotId: string, holderKey: string): Promise<void> {
    try {
      await this.redis.client.eval(RELEASE_SCRIPT, 1, this.key(slotId), holderKey);
    } catch {
      // The key expires on its own; nothing to do.
    }
  }
}
