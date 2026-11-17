import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BookingInfo,
  ChangeResult,
  ClinicBackend,
  DoctorInfo,
  FaqHit,
  HeldSlotInfo,
  PaymentLinkInfo,
  SlotInfo,
  ToolContext,
} from '@clinic/agent';
import { AuthUser, PhoneSchema } from '@clinic/shared';
import { formatInTimeZone } from 'date-fns-tz';
import { BookingView, BookingsService } from '../bookings/bookings.service';
import { Env } from '../config/env';
import { DoctorsService } from '../doctors/doctors.service';
import { EVENT_BUS, EventBus } from '../events/event-bus';
import { PrismaService } from '../prisma/prisma.module';
import { SlotsService } from '../slots/slots.service';
import { AgentSessionsService } from './agent-sessions.service';
import { FaqService } from './faq.service';

// Policy from the clinic FAQ. Inside these windows a change needs staff approval.
const CANCEL_FREE_HOURS = 4;
const RESCHEDULE_FREE_HOURS = 2;

// The agent acts for the patient, so it goes through the same ownership check
// (booking phone number) as a patient calling the REST API.
const STOP_WORDS = new Set(['doctor', 'doctors', 'specialist', 'problem', 'problems', 'issue', 'need', 'for', 'the', 'and', 'with']);

const AGENT_ACTOR: AuthUser = { id: 'agent', role: 'PATIENT', isGuest: true };

/**
 * Implements the agent's ClinicBackend on top of the real services. It
 * translates between the model-friendly shapes (local dates, HH:mm times,
 * short booking references) and the API's own types.
 */
@Injectable()
export class ClinicBackendAdapter implements ClinicBackend {
  private readonly logger = new Logger(ClinicBackendAdapter.name);
  private readonly timezone: string;
  private readonly holdMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly doctors: DoctorsService,
    private readonly slots: SlotsService,
    private readonly bookings: BookingsService,
    private readonly faq: FaqService,
    private readonly sessions: AgentSessionsService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    config: ConfigService<Env, true>,
  ) {
    this.timezone = config.get('CLINIC_TIMEZONE', { infer: true });
    this.holdMinutes = config.get('SLOT_HOLD_MINUTES', { infer: true });
  }

  async searchDoctors(query: { specialization?: string; name?: string }): Promise<DoctorInfo[]> {
    const all = await this.doctors.search({});
    const wantedName = query.name?.toLowerCase().replace(/^dr\.?\s*/, '').trim();

    // Patients say "heart doctor" or "skin problem", not "cardiology". Each
    // query word is cut to a five-letter stem ("cardiologist" -> "cardi") and
    // looked for in the doctor's specialization and bio.
    const stems = (query.specialization ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map((w) => w.slice(0, 5));

    const matches = all.filter((d) => {
      const haystack = `${d.specialization} ${d.bio ?? ''}`.toLowerCase();
      return (
        (stems.length === 0 || stems.some((stem) => haystack.includes(stem))) &&
        (!wantedName || d.name.toLowerCase().includes(wantedName))
      );
    });
    // Nothing matched: return everyone so the model picks from real doctors
    // instead of inventing one.
    return (matches.length ? matches : all).map((d) => ({
      doctorId: d.id,
      name: d.name,
      specialization: d.specialization,
      feeInr: d.feeInr,
      about: d.bio ?? undefined,
    }));
  }

  async getAvailableSlots(query: { doctorId: string; date: string }): Promise<SlotInfo[]> {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: query.doctorId }, select: { id: true } });
    if (!doctor) throw new Error('Unknown doctorId. Call searchDoctors first and copy the doctorId exactly.');
    const slots = await this.slots.listAvailable(query.doctorId, query.date);
    return slots.map((s) => this.slotInfo(s));
  }

  async holdSlot(input: { slotId: string }, ctx: ToolContext): Promise<HeldSlotInfo> {
    const slot = await this.slots.hold(input.slotId, ctx.threadId);
    await this.slots.releaseOtherHolds(ctx.threadId, slot.id);
    const doctor = await this.prisma.doctor.findUniqueOrThrow({ where: { id: slot.doctorId } });
    return { ...this.slotInfo(slot), doctorName: doctor.name, feeInr: doctor.feeInr, holdMinutes: this.holdMinutes };
  }

  async confirmBooking(
    input: { slotId: string; patientName: string; phone: string; email?: string; reason?: string },
    ctx: ToolContext,
  ): Promise<BookingInfo> {
    const booking = await this.bookings.confirm({
      slotId: input.slotId,
      holderKey: ctx.threadId,
      patient: { name: input.patientName, phone: input.phone, email: input.email },
      channel: ctx.channel,
      reason: input.reason,
      // Deterministic, so the model calling this tool twice creates one booking.
      idempotencyKey: `${ctx.threadId}:${input.slotId}`,
    });
    await this.sessions.recordOutcome(ctx.threadId, 'BOOKED', booking.patient.id);
    return this.bookingInfo(booking);
  }

  async getBookingStatus(input: { bookingId: string; phone: string }): Promise<BookingInfo> {
    return this.bookingInfo(await this.findOwned(input.bookingId, input.phone));
  }

  async cancelBooking(
    input: { bookingId: string; phone: string; reason?: string; approved?: boolean },
    ctx: ToolContext,
  ): Promise<ChangeResult> {
    const booking = await this.findOwned(input.bookingId, input.phone);
    if (booking.status === 'CANCELLED') return { outcome: 'DONE', booking: this.bookingInfo(booking) };

    if (!input.approved) {
      const reasons: string[] = [];
      if (booking.paymentStatus === 'PAID') reasons.push(`a refund of ₹${booking.feeInr} is involved`);
      if (this.hoursUntil(booking) < CANCEL_FREE_HOURS) {
        reasons.push(`the appointment is less than ${CANCEL_FREE_HOURS} hours away`);
      }
      if (reasons.length) {
        return {
          outcome: 'APPROVAL_REQUIRED',
          reason: `Cancel ${booking.reference} (${this.describe(booking)}): ${reasons.join(' and ')}.`,
          booking: this.bookingInfo(booking),
        };
      }
    }

    const cancelled = await this.bookings.cancel(booking.id, input.reason, AGENT_ACTOR, input.phone);
    await this.sessions.recordOutcome(ctx.threadId, 'CANCELLED', cancelled.patient.id);
    return { outcome: 'DONE', booking: this.bookingInfo(cancelled) };
  }

  async rescheduleBooking(
    input: { bookingId: string; phone: string; newSlotId: string; approved?: boolean },
    ctx: ToolContext,
  ): Promise<ChangeResult> {
    const booking = await this.findOwned(input.bookingId, input.phone);
    if (booking.slot.id === input.newSlotId) return { outcome: 'DONE', booking: this.bookingInfo(booking) };

    if (!input.approved && this.hoursUntil(booking) < RESCHEDULE_FREE_HOURS) {
      return {
        outcome: 'APPROVAL_REQUIRED',
        reason: `Reschedule ${booking.reference} (${this.describe(booking)}): the appointment is less than ${RESCHEDULE_FREE_HOURS} hours away.`,
        booking: this.bookingInfo(booking),
      };
    }

    const moved = await this.bookings.reschedule(booking.id, input.newSlotId, ctx.threadId, AGENT_ACTOR, input.phone);
    await this.sessions.recordOutcome(ctx.threadId, 'RESCHEDULED', moved.patient.id);
    return { outcome: 'DONE', booking: this.bookingInfo(moved) };
  }

  async createPaymentLink(input: { bookingId: string; phone: string }): Promise<PaymentLinkInfo> {
    const booking = await this.findOwned(input.bookingId, input.phone);
    if (booking.paymentStatus === 'PAID') {
      return { available: false, amountInr: booking.feeInr, message: 'This booking is already paid.' };
    }
    // Razorpay payment links arrive in phase 5.
    return {
      available: false,
      amountInr: booking.feeInr,
      message: `Online payment is not available yet. Please pay ₹${booking.feeInr} at the clinic reception before the appointment.`,
    };
  }

  async transferToHuman(input: { reason: string }, ctx: ToolContext): Promise<{ message: string }> {
    await this.sessions.recordOutcome(ctx.threadId, 'HANDOFF');
    await this.events.publish({ type: 'agent.handoff', threadId: ctx.threadId, reason: input.reason });
    this.logger.log(`Conversation ${ctx.threadId} handed to staff`);
    return { message: 'The clinic staff have been notified and will take over this conversation.' };
  }

  searchFaq(query: string): Promise<FaqHit[]> {
    return this.faq.search(query);
  }

  // ---------- helpers ----------

  /** Finds a booking by its reference, but only if the phone number matches. */
  private async findOwned(reference: string, phone: string): Promise<BookingView> {
    const notFound = new Error('No booking was found with that booking ID and phone number.');
    const parsed = PhoneSchema.safeParse(phone);
    if (!parsed.success) throw notFound;
    const booking = await this.bookings.getByReference(reference).catch(() => undefined);
    if (!booking || booking.patient.phone !== parsed.data) throw notFound;
    return booking;
  }

  private hoursUntil(booking: BookingView): number {
    return (booking.slot.startTime.getTime() - Date.now()) / 3_600_000;
  }

  private describe(booking: BookingView): string {
    return `${booking.doctor.name}, ${formatInTimeZone(booking.slot.startTime, this.timezone, 'EEE d MMM, h:mm a')}`;
  }

  private slotInfo(slot: { id: string; startTime: Date }): SlotInfo {
    return {
      slotId: slot.id,
      date: formatInTimeZone(slot.startTime, this.timezone, 'yyyy-MM-dd'),
      time: formatInTimeZone(slot.startTime, this.timezone, 'HH:mm'),
    };
  }

  private bookingInfo(booking: BookingView): BookingInfo {
    return {
      bookingId: booking.reference,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      doctorId: booking.doctor.id,
      doctorName: booking.doctor.name,
      specialization: booking.doctor.specialization,
      date: formatInTimeZone(booking.slot.startTime, this.timezone, 'yyyy-MM-dd'),
      time: formatInTimeZone(booking.slot.startTime, this.timezone, 'HH:mm'),
      feeInr: booking.feeInr,
      patientName: booking.patient.name,
    };
  }
}
