import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Slot } from '@prisma/client';
import { addDays, dayBoundsUtc, dbDateToString, localDateString, zonedToUtc } from '../common/time';
import { Env } from '../config/env';
import { EVENT_BUS, EventBus } from '../events/event-bus';
import { PrismaService } from '../prisma/prisma.module';
import { generateSlots } from './slot-generator';
import { SlotLockService } from './slot-lock.service';

export interface SyncResult {
  created: number;
  removed: number;
  /** Booked slots that now fall outside the schedule; an admin must handle these. */
  conflicts: number;
}

@Injectable()
export class SlotsService {
  private readonly logger = new Logger(SlotsService.name);
  private readonly timezone: string;
  private readonly holdMinutes: number;
  private readonly horizonDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SlotLockService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    config: ConfigService<Env, true>,
  ) {
    this.timezone = config.get('CLINIC_TIMEZONE', { infer: true });
    this.holdMinutes = config.get('SLOT_HOLD_MINUTES', { infer: true });
    this.horizonDays = config.get('SLOT_GENERATION_DAYS', { infer: true });
  }

  // ---------- Generation ----------

  /**
   * Brings a doctor's future slots in line with their working hours and leaves.
   * Safe to run any number of times: it only adds what is missing and removes
   * free slots that no longer belong. Held and booked slots are never touched.
   */
  async syncDoctorSlots(doctorId: string): Promise<SyncResult> {
    const now = new Date();
    const today = localDateString(now, this.timezone);
    const horizonEnd = zonedToUtc(addDays(today, this.horizonDays), '00:00', this.timezone);

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { workingHours: true, leaves: { where: { endDate: { gte: new Date(`${today}T00:00:00Z`) } } } },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');

    const desired = doctor.isActive
      ? generateSlots({
          workingHours: doctor.workingHours,
          leaves: doctor.leaves.map((l) => ({
            startDate: dbDateToString(l.startDate),
            endDate: dbDateToString(l.endDate),
          })),
          slotMinutes: doctor.slotMinutes,
          fromDate: today,
          days: this.horizonDays,
          timezone: this.timezone,
        }).filter((s) => s.startTime > now)
      : [];
    const desiredByStart = new Map(desired.map((s) => [s.startTime.getTime(), s]));

    const existing = await this.prisma.slot.findMany({
      where: { doctorId, startTime: { gt: now, lt: horizonEnd } },
      include: { _count: { select: { bookings: true } } },
    });
    const taken = existing.filter((s) => s.status === 'HELD' || s.status === 'BOOKED');

    const matches = (s: Slot) => desiredByStart.get(s.startTime.getTime())?.endTime.getTime() === s.endTime.getTime();
    const stale = existing.filter((s) => s.status === 'FREE' && !matches(s));
    // A slot with booking history cannot be deleted (cancelled bookings still
    // point at it), so it is parked as BLOCKED instead.
    const toDelete = stale.filter((s) => s._count.bookings === 0).map((s) => s.id);
    const toBlock = stale.filter((s) => s._count.bookings > 0).map((s) => s.id);
    const toUnblock = existing.filter((s) => s.status === 'BLOCKED' && matches(s)).map((s) => s.id);

    const keptStarts = new Set(
      existing.filter((s) => !toDelete.includes(s.id)).map((s) => s.startTime.getTime()),
    );
    const toCreate = desired.filter(
      (d) =>
        !keptStarts.has(d.startTime.getTime()) &&
        // e.g. slot length changed from 30 to 20 minutes while 10:00-10:30 is booked
        !taken.some((t) => d.startTime < t.endTime && t.startTime < d.endTime),
    );

    const [deleted, , , created] = await this.prisma.$transaction([
      this.prisma.slot.deleteMany({ where: { id: { in: toDelete }, status: 'FREE' } }),
      this.prisma.slot.updateMany({ where: { id: { in: toBlock }, status: 'FREE' }, data: { status: 'BLOCKED' } }),
      this.prisma.slot.updateMany({ where: { id: { in: toUnblock }, status: 'BLOCKED' }, data: { status: 'FREE' } }),
      this.prisma.slot.createMany({
        data: toCreate.map((s) => ({ doctorId, startTime: s.startTime, endTime: s.endTime })),
        skipDuplicates: true,
      }),
    ]);

    const result: SyncResult = {
      created: created.count + toUnblock.length,
      removed: deleted.count + toBlock.length,
      conflicts: taken.filter((s) => s.status === 'BOOKED' && !matches(s)).length,
    };
    if (result.created || result.removed) {
      await this.events.publish({ type: 'slots.generated', doctorId, ...result });
    }
    return result;
  }

  async syncAllDoctors(): Promise<SyncResult> {
    const doctors = await this.prisma.doctor.findMany({ select: { id: true } });
    const total: SyncResult = { created: 0, removed: 0, conflicts: 0 };
    for (const d of doctors) {
      const r = await this.syncDoctorSlots(d.id);
      total.created += r.created;
      total.removed += r.removed;
      total.conflicts += r.conflicts;
    }
    return total;
  }

  // ---------- Queries ----------

  /** Slots a patient can book on one local day. An expired hold counts as free. */
  listAvailable(doctorId: string, date: string) {
    const now = new Date();
    const { start, end } = dayBoundsUtc(date, this.timezone);
    return this.prisma.slot.findMany({
      where: {
        doctorId,
        startTime: { gte: start > now ? start : now, lt: end },
        OR: [{ status: 'FREE' }, { status: 'HELD', heldUntil: { lt: now } }],
      },
      select: { id: true, doctorId: true, startTime: true, endTime: true },
      orderBy: { startTime: 'asc' },
    });
  }

  /** Every slot in a date range, whatever its status. For the dashboard. */
  listForDoctor(doctorId: string, fromDate: string, toDate: string) {
    return this.prisma.slot.findMany({
      where: {
        doctorId,
        startTime: {
          gte: dayBoundsUtc(fromDate, this.timezone).start,
          lt: dayBoundsUtc(toDate, this.timezone).end,
        },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  // ---------- Holds ----------

  /**
   * Reserves a slot for `holderKey` for SLOT_HOLD_MINUTES. Idempotent: calling
   * it again with the same holder just refreshes the hold.
   */
  async hold(slotId: string, holderKey: string): Promise<Slot> {
    const now = new Date();
    const heldUntil = new Date(now.getTime() + this.holdMinutes * 60_000);

    const lock = await this.lock.acquire(slotId, holderKey, this.holdMinutes * 60);
    if (lock === 'taken') throw new ConflictException('This slot is being booked by someone else');

    // The real guard. The WHERE clause and the write happen atomically in
    // Postgres, so of two concurrent requests exactly one updates a row.
    const { count } = await this.prisma.slot.updateMany({
      where: {
        id: slotId,
        startTime: { gt: now },
        OR: [
          { status: 'FREE' },
          { status: 'HELD', heldUntil: { lt: now } },
          { status: 'HELD', heldBy: holderKey },
        ],
      },
      data: { status: 'HELD', heldBy: holderKey, heldUntil },
    });

    if (count === 0) {
      if (lock === 'acquired') await this.lock.release(slotId, holderKey);
      const exists = await this.prisma.slot.findUnique({ where: { id: slotId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Slot not found');
      throw new ConflictException('This slot is no longer available');
    }

    const slot = await this.prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
    await this.events.publish({
      type: 'slot.held',
      slotId,
      doctorId: slot.doctorId,
      heldUntil: heldUntil.toISOString(),
    });
    return slot;
  }

  /** Gives a held slot back. A no-op if the caller does not own the hold. */
  async releaseHold(slotId: string, holderKey: string): Promise<{ released: boolean }> {
    const slot = await this.prisma.slot.findUnique({ where: { id: slotId } });
    if (!slot) throw new NotFoundException('Slot not found');

    const { count } = await this.prisma.slot.updateMany({
      where: { id: slotId, status: 'HELD', heldBy: holderKey },
      data: { status: 'FREE', heldBy: null, heldUntil: null },
    });
    await this.lock.release(slotId, holderKey);
    if (count > 0) await this.events.publish({ type: 'slot.released', slotId, doctorId: slot.doctorId });
    return { released: count > 0 };
  }

  /** Called by the scheduler every minute. */
  async releaseExpiredHolds(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.slot.findMany({
      where: { status: 'HELD', heldUntil: { lt: now } },
      select: { id: true, doctorId: true },
    });
    if (expired.length === 0) return 0;

    // Re-check the condition in the UPDATE: a slot may have been confirmed or
    // re-held between the SELECT above and now.
    const { count } = await this.prisma.slot.updateMany({
      where: { id: { in: expired.map((s) => s.id) }, status: 'HELD', heldUntil: { lt: now } },
      data: { status: 'FREE', heldBy: null, heldUntil: null },
    });
    for (const s of expired) {
      await this.events.publish({ type: 'slot.released', slotId: s.id, doctorId: s.doctorId });
    }
    this.logger.log(`Released ${count} expired hold(s)`);
    return count;
  }
}
