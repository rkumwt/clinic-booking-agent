import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser, BookingStatus, ConfirmBookingInput, PhoneSchema } from '@clinic/shared';
import { Prisma } from '@prisma/client';
import { maskPhone } from '../common/mask';
import { dayBoundsUtc } from '../common/time';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { EVENT_BUS, EventBus } from '../events/event-bus';
import { PrismaService } from '../prisma/prisma.module';
import { SlotLockService } from '../slots/slot-lock.service';
import { SlotsService } from '../slots/slots.service';

const BOOKING_VIEW = {
  slot: { select: { id: true, startTime: true, endTime: true } },
  doctor: { select: { id: true, name: true, specialization: true } },
  patient: { select: { id: true, name: true, phone: true, email: true } },
} satisfies Prisma.BookingInclude;

export type BookingView = Prisma.BookingGetPayload<{ include: typeof BOOKING_VIEW }>;

const ACTIVE: BookingStatus[] = ['PENDING_PAYMENT', 'CONFIRMED'];

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private readonly timezone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotsService,
    private readonly lock: SlotLockService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    config: ConfigService<Env, true>,
  ) {
    this.timezone = config.get('CLINIC_TIMEZONE', { infer: true });
  }

  // ---------- Queries ----------

  async get(id: string): Promise<BookingView> {
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: BOOKING_VIEW });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async list(actor: AuthUser, filter: { status?: BookingStatus; doctorId?: string; date?: string }) {
    let doctorId = filter.doctorId;
    if (actor.role === 'DOCTOR') {
      // A doctor only ever sees their own bookings, whatever filter was sent.
      const own = await this.prisma.doctor.findUnique({ where: { userId: actor.id }, select: { id: true } });
      if (!own) return [];
      doctorId = own.id;
    }
    const day = filter.date ? dayBoundsUtc(filter.date, this.timezone) : undefined;
    return this.prisma.booking.findMany({
      where: {
        ...(doctorId ? { doctorId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(day ? { slot: { startTime: { gte: day.start, lt: day.end } } } : {}),
      },
      include: BOOKING_VIEW,
      orderBy: { slot: { startTime: 'asc' } },
      take: 500,
    });
  }

  // ---------- Commands ----------

  /**
   * Turns a held slot into a booking. Idempotent on `idempotencyKey`: a retry
   * (network timeout, the agent calling the tool twice) returns the first booking.
   */
  async confirm(input: ConfirmBookingInput): Promise<BookingView> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    let booking: BookingView;
    try {
      booking = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        // Claim the slot. Only succeeds if this caller still owns a live hold.
        const claimed = await tx.slot.updateMany({
          where: { id: input.slotId, status: 'HELD', heldBy: input.holderKey, heldUntil: { gt: now } },
          data: { status: 'BOOKED', heldBy: null, heldUntil: null },
        });
        if (claimed.count === 0) {
          throw new ConflictException('Your hold on this slot has expired. Please pick a slot again.');
        }

        const slot = await tx.slot.findUniqueOrThrow({ where: { id: input.slotId }, include: { doctor: true } });
        const patient = await tx.patient.upsert({
          where: { phone: input.patient.phone },
          create: input.patient,
          update: { name: input.patient.name, ...(input.patient.email ? { email: input.patient.email } : {}) },
        });

        return tx.booking.create({
          data: {
            slotId: slot.id,
            doctorId: slot.doctorId,
            patientId: patient.id,
            feeInr: slot.doctor.feeInr,
            channel: input.channel,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          },
          include: BOOKING_VIEW,
        });
      });
    } catch (err) {
      // Two requests with the same idempotency key can race past the first
      // lookup. The loser lands here (lost the slot claim, or hit a unique
      // index) and should get the winner's booking, not an error.
      if (err instanceof ConflictException || isUniqueViolation(err)) {
        const winner = await this.findByIdempotencyKey(input.idempotencyKey);
        if (winner) return winner;
        if (isUniqueViolation(err)) throw new ConflictException('This slot has already been booked');
      }
      throw err;
    }

    await this.lock.release(input.slotId, input.holderKey);
    this.logger.log(`Booking ${booking.id} created for patient ${maskPhone(booking.patient.phone)}`);
    await this.events.publish({
      type: 'booking.created',
      bookingId: booking.id,
      doctorId: booking.doctorId,
      slotId: booking.slotId,
    });
    return booking;
  }

  /** Idempotent: cancelling an already-cancelled booking returns it unchanged. */
  async cancel(id: string, reason: string | undefined, actor: AuthUser, phone?: string): Promise<BookingView> {
    const booking = await this.get(id);
    await this.assertCanModify(booking, actor, phone);
    if (booking.status === 'CANCELLED') return booking;
    if (booking.status === 'COMPLETED') throw new BadRequestException('A completed appointment cannot be cancelled');

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id, status: { in: ACTIVE } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason,
          // Money is never returned automatically; an admin approves the refund.
          ...(booking.paymentStatus === 'PAID' ? { paymentStatus: 'REFUND_PENDING' as const } : {}),
        },
      });
      if (updated.count > 0) {
        await tx.slot.updateMany({
          where: { id: booking.slotId, status: 'BOOKED' },
          data: { status: 'FREE', heldBy: null, heldUntil: null },
        });
      }
      return updated.count > 0;
    });

    if (cancelled) {
      // The freed slot may sit inside a leave or outside changed working hours.
      await this.slots.syncDoctorSlots(booking.doctorId).catch((err) => this.logger.error(err));
      await this.events.publish({
        type: 'booking.cancelled',
        bookingId: id,
        doctorId: booking.doctorId,
        slotId: booking.slotId,
      });
    }
    return this.get(id);
  }

  /**
   * Moves a booking to another slot of the same doctor. The new slot is claimed
   * and the old one freed in a single transaction, so the patient never ends up
   * with two slots or none. Idempotent: rescheduling to the current slot is a no-op.
   */
  async reschedule(
    id: string,
    newSlotId: string,
    holderKey: string,
    actor: AuthUser,
    phone?: string,
  ): Promise<BookingView> {
    const booking = await this.get(id);
    await this.assertCanModify(booking, actor, phone);
    if (booking.slotId === newSlotId) return booking;
    if (!ACTIVE.includes(booking.status)) {
      throw new BadRequestException(`A ${booking.status.toLowerCase()} booking cannot be rescheduled`);
    }

    const newSlot = await this.prisma.slot.findUnique({ where: { id: newSlotId } });
    if (!newSlot) throw new NotFoundException('Slot not found');
    if (newSlot.doctorId !== booking.doctorId) {
      throw new BadRequestException('To change doctor, cancel this booking and make a new one');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const claimed = await tx.slot.updateMany({
          where: {
            id: newSlotId,
            startTime: { gt: now },
            OR: [
              { status: 'FREE' },
              { status: 'HELD', heldBy: holderKey },
              { status: 'HELD', heldUntil: { lt: now } },
            ],
          },
          data: { status: 'BOOKED', heldBy: null, heldUntil: null },
        });
        if (claimed.count === 0) throw new ConflictException('This slot is no longer available');

        const moved = await tx.booking.updateMany({
          where: { id, slotId: booking.slotId, status: { in: ACTIVE } },
          data: { slotId: newSlotId },
        });
        // The booking changed underneath us (cancelled or moved by someone else).
        if (moved.count === 0) throw new ConflictException('This booking was changed by someone else. Please retry.');

        await tx.slot.updateMany({
          where: { id: booking.slotId, status: 'BOOKED' },
          data: { status: 'FREE', heldBy: null, heldUntil: null },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('This slot has already been booked');
      throw err;
    }

    await this.lock.release(newSlotId, holderKey);
    await this.slots.syncDoctorSlots(booking.doctorId).catch((err) => this.logger.error(err));
    await this.events.publish({
      type: 'booking.rescheduled',
      bookingId: id,
      doctorId: booking.doctorId,
      fromSlotId: booking.slotId,
      toSlotId: newSlotId,
    });
    return this.get(id);
  }

  // ---------- Helpers ----------

  private findByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.booking.findUnique({ where: { idempotencyKey }, include: BOOKING_VIEW });
  }

  /**
   * Admins can change any booking and doctors their own. A patient must prove
   * the booking is theirs by giving the phone number it was made with.
   */
  private async assertCanModify(booking: BookingView, actor: AuthUser, phone?: string) {
    if (actor.role === 'ADMIN') return;
    if (actor.role === 'DOCTOR') {
      const own = await this.prisma.doctor.findUnique({ where: { userId: actor.id }, select: { id: true } });
      if (own?.id === booking.doctorId) return;
      throw new ForbiddenException('This booking belongs to another doctor');
    }
    const parsed = PhoneSchema.safeParse(phone ?? '');
    if (parsed.success && parsed.data === booking.patient.phone) return;
    // Same answer whether the booking exists or the phone is wrong.
    throw new NotFoundException('Booking not found');
  }
}
