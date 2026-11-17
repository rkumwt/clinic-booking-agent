import { Doctor } from '@prisma/client';
import request from 'supertest';
import { addDays, localDateString } from '../src/common/time';
import { SlotLockService } from '../src/slots/slot-lock.service';
import { TestContext, createDoctorWithSlots, createTestApp, createUser, newKey, nextPhone, slotPicker } from './utils';

describe('Booking service (e2e)', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let doctorUser: Awaited<ReturnType<typeof createUser>>;
  let otherDoctorUser: Awaited<ReturnType<typeof createUser>>;
  let doctor: Doctor;
  let otherDoctor: Doctor;
  let guestToken: string;
  let pickSlot: ReturnType<typeof slotPicker>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx, 'ADMIN');
    doctorUser = await createUser(ctx, 'DOCTOR');
    otherDoctorUser = await createUser(ctx, 'DOCTOR');
    doctor = await createDoctorWithSlots(ctx, doctorUser.user.id);
    otherDoctor = await createDoctorWithSlots(ctx, otherDoctorUser.user.id);
    guestToken = (await ctx.auth.issueGuestToken()).accessToken;
    pickSlot = slotPicker(ctx, doctor.id);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  const as = (token: string) => ({
    get: (url: string) => request(ctx.app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) =>
      request(ctx.app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body),
    delete: (url: string, body: object = {}) =>
      request(ctx.app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`).send(body),
  });
  const guest = () => as(guestToken);
  const slotStatus = async (id: string) => (await ctx.prisma.slot.findUniqueOrThrow({ where: { id } })).status;

  /** Hold + confirm, the happy path used as setup by several tests. */
  async function book(slotId: string, phone = nextPhone()) {
    const holderKey = newKey();
    await guest().post(`/slots/${slotId}/hold`, { holderKey }).expect(200);
    const res = await guest()
      .post('/bookings', {
        slotId,
        holderKey,
        idempotencyKey: newKey(),
        patient: { name: 'Test Patient', phone },
      })
      .expect(201);
    return { booking: res.body, phone, holderKey };
  }

  describe('slot generation', () => {
    it('creates slots from working hours and is idempotent', async () => {
      const before = await ctx.prisma.slot.count({ where: { doctorId: doctor.id } });
      expect(before).toBeGreaterThan(60); // 6 slots a day for ~14 days
      const again = await ctx.slots.syncDoctorSlots(doctor.id);
      expect(again).toEqual({ created: 0, removed: 0, conflicts: 0 });
      expect(await ctx.prisma.slot.count({ where: { doctorId: doctor.id } })).toBe(before);
    });

    it('removes free slots when a leave is added and restores them when it is removed', async () => {
      const day = addDays(localDateString(new Date(), 'Asia/Kolkata'), 5);
      const list = () => request(ctx.app.getHttpServer()).get(`/doctors/${otherDoctor.id}/slots?date=${day}`);
      expect((await list()).body).toHaveLength(6);

      const leave = await as(admin.token)
        .post(`/doctors/${otherDoctor.id}/leaves`, { startDate: day, endDate: day })
        .expect(201);
      expect(leave.body.slots.removed).toBe(6);
      expect((await list()).body).toHaveLength(0);

      await as(admin.token).delete(`/doctors/${otherDoctor.id}/leaves/${leave.body.id}`).expect(200);
      expect((await list()).body).toHaveLength(6);
    });

    it('reports booked slots inside a new leave as conflicts instead of deleting them', async () => {
      const day = addDays(localDateString(new Date(), 'Asia/Kolkata'), 6);
      const slots = (await request(ctx.app.getHttpServer()).get(`/doctors/${otherDoctor.id}/slots?date=${day}`)).body;
      const { booking } = await book(slots[0].id);

      const leave = await as(admin.token)
        .post(`/doctors/${otherDoctor.id}/leaves`, { startDate: day, endDate: day })
        .expect(201);
      expect(leave.body.slots).toMatchObject({ removed: 5, conflicts: 1 });
      expect(await slotStatus(slots[0].id)).toBe('BOOKED');

      // Cancelling the conflicting booking must not put the slot back on sale.
      await as(admin.token).post(`/bookings/${booking.id}/cancel`).expect(200);
      expect(await slotStatus(slots[0].id)).toBe('BLOCKED');
    });

    it('lets a doctor manage only their own schedule', async () => {
      const body = { workingHours: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }] };
      const res = await request(ctx.app.getHttpServer())
        .put(`/doctors/${doctor.id}/working-hours`)
        .set('Authorization', `Bearer ${otherDoctorUser.token}`)
        .send(body);
      expect(res.status).toBe(403);
    });
  });

  describe('hold', () => {
    it('holds a free slot and hides it from availability', async () => {
      const slot = await pickSlot();
      const res = await guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('HELD');
      const minutesHeld = (new Date(res.body.heldUntil).getTime() - Date.now()) / 60_000;
      expect(minutesHeld).toBeGreaterThan(9);
      expect(minutesHeld).toBeLessThanOrEqual(10);

      const day = localDateString(slot.startTime, 'Asia/Kolkata');
      const available = await request(ctx.app.getHttpServer()).get(`/doctors/${doctor.id}/slots?date=${day}`);
      expect(available.body.map((s: { id: string }) => s.id)).not.toContain(slot.id);
    });

    it('is idempotent for the same holder and rejects a different holder', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      await guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() }).expect(409);
    });

    it('lets exactly one of 20 concurrent holders win', async () => {
      const slot = await pickSlot();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    });

    it('still lets exactly one holder win when Redis is unavailable', async () => {
      jest.spyOn(ctx.app.get(SlotLockService), 'acquire').mockResolvedValue('unavailable');
      const slot = await pickSlot();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    });

    it('releases a hold on request, but only for its owner', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);

      const stranger = await guest().delete(`/slots/${slot.id}/hold`, { holderKey: newKey() });
      expect(stranger.body).toEqual({ released: false });
      expect(await slotStatus(slot.id)).toBe('HELD');

      const owner = await guest().delete(`/slots/${slot.id}/hold`, { holderKey });
      expect(owner.body).toEqual({ released: true });
      expect(await slotStatus(slot.id)).toBe('FREE');
      // And the Redis lock is gone too, so someone else can hold it straight away.
      await guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() }).expect(200);
    });

    it('frees expired holds via the scheduled job', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      await ctx.prisma.slot.update({ where: { id: slot.id }, data: { heldUntil: new Date(Date.now() - 1000) } });

      expect(await ctx.slots.releaseExpiredHolds()).toBe(1);
      expect(await slotStatus(slot.id)).toBe('FREE');

      // The late holder can no longer confirm.
      const late = await guest().post('/bookings', {
        slotId: slot.id,
        holderKey,
        idempotencyKey: newKey(),
        patient: { name: 'Late Patient', phone: nextPhone() },
      });
      expect(late.status).toBe(409);
    });

    it('returns 404 for an unknown slot and 400 for a bad body', async () => {
      await guest().post('/slots/does-not-exist/hold', { holderKey: newKey() }).expect(404);
      await guest().post(`/slots/${(await pickSlot()).id}/hold`, { holderKey: 'short' }).expect(400);
    });
  });

  describe('confirm', () => {
    it('creates a booking from a held slot', async () => {
      const slot = await pickSlot();
      const { booking, phone } = await book(slot.id);
      expect(booking).toMatchObject({
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        channel: 'CHAT',
        feeInr: 700,
        slot: { id: slot.id },
        doctor: { id: doctor.id },
        patient: { phone: `+91${phone}` },
      });
      expect(await slotStatus(slot.id)).toBe('BOOKED');
    });

    it('returns the same booking when retried with the same idempotency key', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      const body = { slotId: slot.id, holderKey, idempotencyKey: newKey(), patient: { name: 'Retry', phone: nextPhone() } };

      const first = await guest().post('/bookings', body).expect(201);
      const second = await guest().post('/bookings', body).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(await ctx.prisma.booking.count({ where: { slotId: slot.id } })).toBe(1);
    });

    it('creates one booking when the same request is sent 5 times at once', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      const body = { slotId: slot.id, holderKey, idempotencyKey: newKey(), patient: { name: 'Burst', phone: nextPhone() } };

      const results = await Promise.all(Array.from({ length: 5 }, () => guest().post('/bookings', body)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await ctx.prisma.booking.count({ where: { slotId: slot.id } })).toBe(1);
    });

    it('refuses to confirm without a hold, or with someone else’s hold', async () => {
      const slot = await pickSlot();
      const patient = { name: 'No Hold', phone: nextPhone() };
      await guest()
        .post('/bookings', { slotId: slot.id, holderKey: newKey(), idempotencyKey: newKey(), patient })
        .expect(409);

      await guest().post(`/slots/${slot.id}/hold`, { holderKey: newKey() }).expect(200);
      await guest()
        .post('/bookings', { slotId: slot.id, holderKey: newKey(), idempotencyKey: newKey(), patient })
        .expect(409);
      expect(await ctx.prisma.booking.count({ where: { slotId: slot.id } })).toBe(0);
    });

    it('rejects an invalid phone number', async () => {
      const slot = await pickSlot();
      const holderKey = newKey();
      await guest().post(`/slots/${slot.id}/hold`, { holderKey }).expect(200);
      const res = await guest().post('/bookings', {
        slotId: slot.id,
        holderKey,
        idempotencyKey: newKey(),
        patient: { name: 'Bad Phone', phone: '12345' },
      });
      expect(res.status).toBe(400);
    });

    it('the database itself refuses a second active booking for a slot', async () => {
      const slot = await pickSlot();
      const { booking } = await book(slot.id);
      // Bypass the service entirely, as a buggy code path might.
      const duplicate = ctx.prisma.booking.create({
        data: {
          slotId: slot.id,
          doctorId: doctor.id,
          patientId: booking.patient.id,
          feeInr: 700,
          idempotencyKey: newKey(),
        },
      });
      await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('cancel', () => {
    it('cancels, frees the slot, and is idempotent', async () => {
      const slot = await pickSlot();
      const { booking } = await book(slot.id);

      const first = await as(admin.token).post(`/bookings/${booking.id}/cancel`, { reason: 'Patient request' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Patient request' });
      expect(await slotStatus(slot.id)).toBe('FREE');

      const second = await as(admin.token).post(`/bookings/${booking.id}/cancel`, { reason: 'again' });
      expect(second.status).toBe(200);
      expect(second.body.cancelReason).toBe('Patient request');
      expect(second.body.cancelledAt).toBe(first.body.cancelledAt);
    });

    it('lets the slot be booked again after a cancellation', async () => {
      const slot = await pickSlot();
      const { booking } = await book(slot.id);
      await as(admin.token).post(`/bookings/${booking.id}/cancel`).expect(200);

      const rebooked = await book(slot.id);
      expect(rebooked.booking.id).not.toBe(booking.id);
      expect(await ctx.prisma.booking.count({ where: { slotId: slot.id } })).toBe(2);
    });

    it('marks a paid booking as refund pending rather than refunding it', async () => {
      const { booking } = await book((await pickSlot()).id);
      await ctx.prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CONFIRMED', paymentStatus: 'PAID' },
      });
      const res = await as(admin.token).post(`/bookings/${booking.id}/cancel`).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUND_PENDING' });
    });

    it('requires a patient to prove ownership with the booking phone number', async () => {
      const { booking, phone } = await book((await pickSlot()).id);

      await guest().post(`/bookings/${booking.id}/cancel`).expect(404);
      await guest().post(`/bookings/${booking.id}/cancel`, { phone: nextPhone() }).expect(404);
      const ok = await guest().post(`/bookings/${booking.id}/cancel`, { phone });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('CANCELLED');
    });

    it('stops a doctor cancelling another doctor’s booking', async () => {
      const { booking } = await book((await pickSlot()).id);
      await as(otherDoctorUser.token).post(`/bookings/${booking.id}/cancel`).expect(403);
      await as(doctorUser.token).post(`/bookings/${booking.id}/cancel`).expect(200);
    });
  });

  describe('reschedule', () => {
    it('moves the booking, books the new slot and frees the old one', async () => {
      const from = await pickSlot();
      const to = await pickSlot();
      const { booking, phone } = await book(from.id);

      const holderKey = newKey();
      await guest().post(`/slots/${to.id}/hold`, { holderKey }).expect(200);
      const res = await guest().post(`/bookings/${booking.id}/reschedule`, { newSlotId: to.id, holderKey, phone });

      expect(res.status).toBe(200);
      expect(res.body.slot.id).toBe(to.id);
      expect(res.body.status).toBe('PENDING_PAYMENT');
      expect(await slotStatus(from.id)).toBe('FREE');
      expect(await slotStatus(to.id)).toBe('BOOKED');

      // Retrying the same reschedule changes nothing.
      const retry = await guest().post(`/bookings/${booking.id}/reschedule`, { newSlotId: to.id, holderKey, phone });
      expect(retry.status).toBe(200);
      expect(retry.body.slot.id).toBe(to.id);
    });

    it('refuses a slot that is taken and leaves the booking where it was', async () => {
      const from = await pickSlot();
      const taken = await pickSlot();
      const { booking } = await book(from.id);
      await book(taken.id);

      await as(admin.token)
        .post(`/bookings/${booking.id}/reschedule`, { newSlotId: taken.id, holderKey: newKey() })
        .expect(409);
      expect((await as(admin.token).get(`/bookings/${booking.id}`)).body.slot.id).toBe(from.id);
      expect(await slotStatus(from.id)).toBe('BOOKED');
    });

    it('refuses a slot held by someone else', async () => {
      const { booking } = await book((await pickSlot()).id);
      const held = await pickSlot();
      await guest().post(`/slots/${held.id}/hold`, { holderKey: newKey() }).expect(200);
      await as(admin.token)
        .post(`/bookings/${booking.id}/reschedule`, { newSlotId: held.id, holderKey: newKey() })
        .expect(409);
    });

    it('refuses another doctor’s slot and a cancelled booking', async () => {
      const { booking } = await book((await pickSlot()).id);
      const foreign = await ctx.prisma.slot.findFirstOrThrow({ where: { doctorId: otherDoctor.id, status: 'FREE' } });
      await as(admin.token)
        .post(`/bookings/${booking.id}/reschedule`, { newSlotId: foreign.id, holderKey: newKey() })
        .expect(400);

      await as(admin.token).post(`/bookings/${booking.id}/cancel`).expect(200);
      await as(admin.token)
        .post(`/bookings/${booking.id}/reschedule`, { newSlotId: (await pickSlot()).id, holderKey: newKey() })
        .expect(400);
    });

    it('gives the slot to one booking when two reschedule into it at once', async () => {
      const a = await book((await pickSlot()).id);
      const b = await book((await pickSlot()).id);
      const target = await pickSlot();

      const results = await Promise.all(
        [a, b].map((x) =>
          as(admin.token).post(`/bookings/${x.booking.id}/reschedule`, { newSlotId: target.id, holderKey: newKey() }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const active = await ctx.prisma.booking.count({ where: { slotId: target.id, status: { not: 'CANCELLED' } } });
      expect(active).toBe(1);
    });
  });

  describe('listing', () => {
    it('shows a doctor only their own bookings and blocks patients', async () => {
      await book((await pickSlot()).id);
      const mine = await as(doctorUser.token).get('/bookings').expect(200);
      expect(mine.body.length).toBeGreaterThan(0);
      expect(mine.body.every((b: { doctor: { id: string } }) => b.doctor.id === doctor.id)).toBe(true);

      // Asking for another doctor's bookings is silently scoped back to their own.
      const sneaky = await as(doctorUser.token).get(`/bookings?doctorId=${otherDoctor.id}`).expect(200);
      expect(sneaky.body.every((b: { doctor: { id: string } }) => b.doctor.id === doctor.id)).toBe(true);

      await guest().get('/bookings').expect(403);
    });
  });
});
