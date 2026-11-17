// Domain events. Publishers and subscribers only know this interface, so the
// in-memory bus can be swapped for SQS / EventBridge without touching them.

export type DomainEvent =
  | { type: 'slot.held'; slotId: string; doctorId: string; heldUntil: string }
  | { type: 'slot.released'; slotId: string; doctorId: string }
  | { type: 'slots.generated'; doctorId: string; created: number; removed: number }
  | { type: 'booking.created'; bookingId: string; doctorId: string; slotId: string }
  | { type: 'booking.confirmed'; bookingId: string; doctorId: string; slotId: string }
  | { type: 'booking.cancelled'; bookingId: string; doctorId: string; slotId: string }
  | { type: 'booking.rescheduled'; bookingId: string; doctorId: string; fromSlotId: string; toSlotId: string }
  | { type: 'payment.paid'; bookingId: string; paymentId: string }
  | { type: 'payment.failed'; bookingId: string; paymentId: string }
  | { type: 'approval.requested'; approvalId: string; threadId: string }
  | { type: 'approval.decided'; approvalId: string; threadId: string; approved: boolean }
  | { type: 'agent.handoff'; threadId: string; reason: string };

export type EventType = DomainEvent['type'];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
export type EventHandler<T extends EventType = EventType> = (event: EventOf<T>) => void | Promise<void>;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): void;
  /** Receives every event; used by the dashboard WebSocket gateway. */
  subscribeAll(handler: (event: DomainEvent) => void | Promise<void>): void;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
