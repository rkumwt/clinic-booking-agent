import type { Channel } from '@clinic/shared';

// The agent's only door to the outside world. apps/api implements this on top
// of its services; tests and evals implement it in memory. The agent package
// therefore has no dependency on NestJS, Prisma or Redis.
//
// All dates are YYYY-MM-DD and all times HH:mm in the clinic's timezone, so the
// model never has to convert from UTC.

export interface ToolContext {
  /** Conversation id. Used as the slot holder key and to derive idempotency keys. */
  threadId: string;
  channel: Channel;
}

export interface DoctorInfo {
  doctorId: string;
  name: string;
  specialization: string;
  feeInr: number;
  about?: string;
}

export interface SlotInfo {
  slotId: string;
  date: string;
  time: string;
}

export interface HeldSlotInfo extends SlotInfo {
  doctorName: string;
  feeInr: number;
  holdMinutes: number;
}

export interface BookingInfo {
  bookingId: string;
  status: string;
  paymentStatus: string;
  doctorId: string;
  doctorName: string;
  specialization: string;
  date: string;
  time: string;
  feeInr: number;
  patientName: string;
}

/** A change either happens, or needs a human to approve it first. */
export type ChangeResult =
  | { outcome: 'DONE'; booking: BookingInfo }
  | { outcome: 'APPROVAL_REQUIRED'; reason: string; booking: BookingInfo };

export interface PaymentLinkInfo {
  available: boolean;
  url?: string;
  amountInr?: number;
  message: string;
}

export interface FaqHit {
  title: string;
  content: string;
  score: number;
}

export interface ClinicBackend {
  searchDoctors(query: { specialization?: string; name?: string }): Promise<DoctorInfo[]>;
  getAvailableSlots(query: { doctorId: string; date: string }): Promise<SlotInfo[]>;
  holdSlot(input: { slotId: string }, ctx: ToolContext): Promise<HeldSlotInfo>;
  confirmBooking(
    input: { slotId: string; patientName: string; phone: string; email?: string; reason?: string },
    ctx: ToolContext,
  ): Promise<BookingInfo>;
  getBookingStatus(input: { bookingId: string; phone: string }): Promise<BookingInfo>;
  /** `approved` is set only after an admin has approved the exception. */
  cancelBooking(
    input: { bookingId: string; phone: string; reason?: string; approved?: boolean },
    ctx: ToolContext,
  ): Promise<ChangeResult>;
  rescheduleBooking(
    input: { bookingId: string; phone: string; newSlotId: string; approved?: boolean },
    ctx: ToolContext,
  ): Promise<ChangeResult>;
  createPaymentLink(input: { bookingId: string; phone: string }, ctx: ToolContext): Promise<PaymentLinkInfo>;
  transferToHuman(input: { reason: string }, ctx: ToolContext): Promise<{ message: string }>;
  searchFaq(query: string): Promise<FaqHit[]>;
}

/** What the graph hands to the host application when it pauses for approval. */
export interface ApprovalInterrupt {
  type: 'CANCELLATION' | 'RESCHEDULE';
  bookingId: string;
  summary: string;
}

/** What the host passes back in when it resumes the graph. */
export interface ApprovalDecision {
  approved: boolean;
  note?: string;
}
