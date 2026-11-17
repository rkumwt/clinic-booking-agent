import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { DomainEvent, EVENT_BUS, EventBus, EventHandler, EventType } from './event-bus';

@Injectable()
export class InMemoryEventBus implements EventBus {
  private readonly logger = new Logger(InMemoryEventBus.name);
  private readonly handlers = new Map<string, Array<(e: DomainEvent) => void | Promise<void>>>();
  private readonly catchAll: Array<(e: DomainEvent) => void | Promise<void>> = [];

  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (e: DomainEvent) => void | Promise<void>);
    this.handlers.set(type, list);
  }

  subscribeAll(handler: (event: DomainEvent) => void | Promise<void>): void {
    this.catchAll.push(handler);
  }

  async publish(event: DomainEvent): Promise<void> {
    const targets = [...(this.handlers.get(event.type) ?? []), ...this.catchAll];
    // A failing subscriber (e.g. email) must never fail the booking that published the event.
    const results = await Promise.allSettled(targets.map(async (h) => h(event)));
    for (const r of results) {
      if (r.status === 'rejected') this.logger.error(`Handler for ${event.type} failed: ${r.reason}`);
    }
  }
}

@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: InMemoryEventBus }],
  exports: [EVENT_BUS],
})
export class EventsModule {}
