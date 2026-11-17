import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import type {
  BookingInfo,
  ChangeResult,
  ClinicBackend,
  DoctorInfo,
  FaqHit,
  HeldSlotInfo,
  PaymentLinkInfo,
  SlotInfo,
  ToolContext,
} from './backend';

// Test doubles, used by this package's unit tests, the API's e2e tests and the
// agent evals. They let the whole graph run with no model and no database.

export type ScriptedStep =
  | string
  | { tool: string; args: Record<string, unknown> }
  | ((messages: BaseMessage[]) => ScriptedStep);

/**
 * A stand-in chat model. `respond` receives the full prompt and returns either
 * text or a tool call, so a test can script a model that behaves well, badly
 * or maliciously.
 */
export class ScriptedModel {
  readonly calls: BaseMessage[][] = [];

  constructor(private readonly respond: (messages: BaseMessage[]) => ScriptedStep) {}

  bindTools() {
    return this;
  }

  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.calls.push(messages);
    let step = this.respond(messages);
    while (typeof step === 'function') step = step(messages);
    if (typeof step === 'string') return new AIMessage(step);
    return new AIMessage({
      content: '',
      tool_calls: [{ name: step.tool, args: step.args, id: `call_${randomUUID()}`, type: 'tool_call' }],
    });
  }

  asChatModel(): BaseChatModel {
    return this as unknown as BaseChatModel;
  }
}

/** The system prompt of a model call, for scripts that react to the current step. */
export function systemText(messages: BaseMessage[]): string {
  return String(messages[0]?.content ?? '');
}

export const TEST_DOCTORS: DoctorInfo[] = [
  { doctorId: 'doc_cardio_1', name: 'Dr. Rohan Mehta', specialization: 'Cardiology', feeInr: 1200 },
  { doctorId: 'doc_derma_1', name: 'Dr. Priya Nair', specialization: 'Dermatology', feeInr: 800 },
];

interface StoredBooking extends BookingInfo {
  phone: string;
  slotId: string;
}

/** A small in-memory clinic: two doctors, four slots a day each. */
export class InMemoryClinic implements ClinicBackend {
  readonly bookings: StoredBooking[] = [];
  readonly held = new Map<string, string>(); // slotId -> threadId
  readonly handoffs: string[] = [];
  /** Booking IDs that need staff approval before they can be changed. */
  readonly needsApproval = new Set<string>();
  private counter = 0;

  private slotsFor(doctorId: string, date: string): SlotInfo[] {
    return ['10:00', '10:30', '11:00', '11:30'].map((time) => ({
      slotId: `${doctorId}_${date}_${time.replace(':', '')}`,
      date,
      time,
    }));
  }

  private parseSlot(slotId: string): { doctor: DoctorInfo; date: string; time: string } {
    const match = slotId.match(/^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/);
    const doctor = TEST_DOCTORS.find((d) => d.doctorId === match?.[1]);
    if (!match || !doctor) throw new Error('Slot not found');
    return { doctor, date: match[2], time: `${match[3]}:${match[4]}` };
  }

  private taken(slotId: string): boolean {
    return this.bookings.some((b) => b.slotId === slotId && b.status !== 'CANCELLED');
  }

  private owned(bookingId: string, phone: string): StoredBooking {
    const booking = this.bookings.find((b) => b.bookingId === bookingId && b.phone === phone);
    if (!booking) throw new Error('No booking was found with that booking ID and phone number.');
    return booking;
  }

  async searchDoctors(query: { specialization?: string; name?: string }): Promise<DoctorInfo[]> {
    const wanted = (query.specialization ?? '').toLowerCase();
    const map: Record<string, string> = { heart: 'cardio', skin: 'derma' };
    const stem = (map[wanted] ?? wanted).slice(0, 5);
    const matches = TEST_DOCTORS.filter((d) => !stem || d.specialization.toLowerCase().startsWith(stem));
    return matches.length ? matches : TEST_DOCTORS;
  }

  async getAvailableSlots(query: { doctorId: string; date: string }): Promise<SlotInfo[]> {
    return this.slotsFor(query.doctorId, query.date).filter((s) => !this.taken(s.slotId) && !this.held.has(s.slotId));
  }

  async holdSlot(input: { slotId: string }, ctx: ToolContext): Promise<HeldSlotInfo> {
    const { doctor, date, time } = this.parseSlot(input.slotId);
    const holder = this.held.get(input.slotId);
    if (this.taken(input.slotId) || (holder && holder !== ctx.threadId)) {
      throw new Error('This slot is no longer available');
    }
    this.held.set(input.slotId, ctx.threadId);
    return { slotId: input.slotId, date, time, doctorName: doctor.name, feeInr: doctor.feeInr, holdMinutes: 10 };
  }

  async confirmBooking(
    input: { slotId: string; patientName: string; phone: string },
    ctx: ToolContext,
  ): Promise<BookingInfo> {
    const existing = this.bookings.find((b) => b.slotId === input.slotId && b.status !== 'CANCELLED');
    if (existing && existing.phone === input.phone) return existing; // idempotent
    if (this.held.get(input.slotId) !== ctx.threadId) throw new Error('Your hold on this slot has expired.');

    const { doctor, date, time } = this.parseSlot(input.slotId);
    const booking: StoredBooking = {
      bookingId: `BK-TEST${String(++this.counter).padStart(2, '0')}`,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
      doctorId: doctor.doctorId,
      doctorName: doctor.name,
      specialization: doctor.specialization,
      date,
      time,
      feeInr: doctor.feeInr,
      patientName: input.patientName,
      phone: input.phone,
      slotId: input.slotId,
    };
    this.bookings.push(booking);
    this.held.delete(input.slotId);
    return booking;
  }

  async getBookingStatus(input: { bookingId: string; phone: string }): Promise<BookingInfo> {
    return this.owned(input.bookingId, input.phone);
  }

  async cancelBooking(input: { bookingId: string; phone: string; approved?: boolean }): Promise<ChangeResult> {
    const booking = this.owned(input.bookingId, input.phone);
    if (this.needsApproval.has(booking.bookingId) && !input.approved) {
      return { outcome: 'APPROVAL_REQUIRED', reason: `Cancel ${booking.bookingId}: a refund is involved.`, booking };
    }
    booking.status = 'CANCELLED';
    return { outcome: 'DONE', booking };
  }

  async rescheduleBooking(
    input: { bookingId: string; phone: string; newSlotId: string; approved?: boolean },
    ctx: ToolContext,
  ): Promise<ChangeResult> {
    const booking = this.owned(input.bookingId, input.phone);
    if (this.needsApproval.has(booking.bookingId) && !input.approved) {
      return { outcome: 'APPROVAL_REQUIRED', reason: `Reschedule ${booking.bookingId}: too close.`, booking };
    }
    if (this.held.get(input.newSlotId) !== ctx.threadId) throw new Error('This slot is no longer available');
    const { date, time } = this.parseSlot(input.newSlotId);
    Object.assign(booking, { slotId: input.newSlotId, date, time });
    this.held.delete(input.newSlotId);
    return { outcome: 'DONE', booking };
  }

  async createPaymentLink(input: { bookingId: string; phone: string }): Promise<PaymentLinkInfo> {
    const booking = this.owned(input.bookingId, input.phone);
    return { available: false, amountInr: booking.feeInr, message: `Please pay ₹${booking.feeInr} at the clinic.` };
  }

  async transferToHuman(input: { reason: string }): Promise<{ message: string }> {
    this.handoffs.push(input.reason);
    return { message: 'The clinic staff have been notified.' };
  }

  async searchFaq(query: string): Promise<FaqHit[]> {
    return /timing|open|hours/i.test(query)
      ? [{ title: 'Clinic timings', content: 'Open Monday to Saturday, 9:00 AM to 8:00 PM.', score: 0.9 }]
      : [];
  }
}
