import { ScriptedModel, ScriptedStep, systemText } from '@clinic/agent';
import type { BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { CHAT_MODEL, EMBEDDINGS } from '../src/agent/agent.providers';
import { TestContext, createDoctorWithSlots, createTestApp, createUser } from './utils';

// The real graph, tools, services, Postgres checkpointer and database, with
// only the language model replaced by a script. No LLM is needed to run this.

const script = (messages: BaseMessage[]): ScriptedStep => {
  const system = systemText(messages);
  if (system.includes('Call searchDoctors now')) return { tool: 'searchDoctors', args: {} };
  if (system.includes('A slot is reserved')) {
    if (!system.includes('mobile number is')) return 'May I have your full name?';
    return 'Shall I confirm this booking?';
  }
  if (system.includes('The booking has not been looked up yet')) return 'What is your booking ID and mobile number?';
  if (system.includes('Booking found')) return 'Are you sure you want to cancel this appointment?';
  return 'Which date would you prefer?';
};

const fakeEmbeddings = {
  embedQuery: async () => Array(1024).fill(0),
  embedDocuments: async (docs: string[]) => docs.map(() => Array(1024).fill(0)),
};

describe('Chat agent (e2e)', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let doctorUser: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createTestApp((builder) =>
      builder
        .overrideProvider(CHAT_MODEL)
        .useValue(new ScriptedModel(script).asChatModel())
        .overrideProvider(EMBEDDINGS)
        .useValue(fakeEmbeddings),
    );
    admin = await createUser(ctx, 'ADMIN');
    doctorUser = await createUser(ctx, 'DOCTOR');
    await createDoctorWithSlots(ctx, doctorUser.user.id);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());

  async function newPatient() {
    const token = (await ctx.auth.issueGuestToken()).accessToken;
    const sessionId = randomUUID();
    const say = async (message: string) => {
      const res = await http().post('/chat').set('Authorization', `Bearer ${token}`).send({ sessionId, message });
      expect(res.status).toBe(200);
      return res.body;
    };
    return { token, sessionId, say };
  }

  async function bookVia(patient: Awaited<ReturnType<typeof newPatient>>, phone: string, time: string) {
    await patient.say('I want to book an appointment with a doctor');
    await patient.say('tomorrow');
    await patient.say(time);
    await patient.say('Asha Verma');
    await patient.say(phone);
    return patient.say('yes');
  }

  it('requires a token', async () => {
    expect((await http().post('/chat').send({ message: 'hi' })).status).toBe(401);
  });

  it('books an appointment through the conversation and records the session', async () => {
    const patient = await newPatient();
    const done = await bookVia(patient, '9876500001', '9:30 am');

    const booking = await ctx.prisma.booking.findFirstOrThrow({
      where: { patient: { phone: '+919876500001' } },
      include: { patient: true, slot: true },
    });
    expect(booking).toMatchObject({ status: 'PENDING_PAYMENT', channel: 'CHAT', patient: { name: 'Asha Verma' } });
    expect(booking.slot.status).toBe('BOOKED');
    expect(done.reply).toContain(booking.reference);
    expect(done.intent).toBe('booking');

    const session = await ctx.prisma.agentSession.findFirstOrThrow({ where: { patientId: booking.patientId } });
    expect(session.outcome).toBe('BOOKED');
    expect(session.latencyMs).toBeGreaterThan(0);

    // The stored transcript has the phone number masked.
    const transcript = JSON.stringify(session.transcript);
    expect(transcript).not.toContain('9876500001');
    expect(transcript).toContain('0001');
  });

  it('remembers the conversation between requests and keeps it private', async () => {
    const patient = await newPatient();
    await patient.say('I want to book an appointment with a doctor');
    await patient.say('tomorrow');

    const mine = await http().get(`/chat/${patient.sessionId}`).set('Authorization', `Bearer ${patient.token}`);
    expect(mine.body).toHaveLength(4);

    // Another guest who knows the session id still sees nothing.
    const stranger = await newPatient();
    const theirs = await http().get(`/chat/${patient.sessionId}`).set('Authorization', `Bearer ${stranger.token}`);
    expect(theirs.body).toEqual([]);
  });

  it('pauses a refund cancellation for approval and resumes when an admin decides', async () => {
    const patient = await newPatient();
    await bookVia(patient, '9876500002', '10:30 am');
    const booking = await ctx.prisma.booking.findFirstOrThrow({ where: { patient: { phone: '+919876500002' } } });
    await ctx.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED', paymentStatus: 'PAID' } });

    await patient.say('I want to cancel my appointment');
    await patient.say(booking.reference);
    const paused = await patient.say('yes');
    expect(paused.pendingApproval).toBe(true);
    expect((await ctx.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');

    // The conversation stays parked while staff decide.
    expect((await patient.say('hello?')).pendingApproval).toBe(true);

    const asAdmin = { Authorization: `Bearer ${admin.token}` };
    expect((await http().get('/approvals').set('Authorization', `Bearer ${doctorUser.token}`)).status).toBe(403);
    const pending = await http().get('/approvals?status=PENDING').set(asAdmin);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ type: 'CANCELLATION', bookingId: booking.id });
    expect(pending.body[0].summary).toContain('refund');

    const decision = await http()
      .post(`/approvals/${pending.body[0].id}/decision`)
      .set(asAdmin)
      .send({ approved: true, note: 'Refund approved' });
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe('APPROVED');
    expect(decision.body.reply).toMatch(/has been cancelled/);

    expect(await ctx.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'REFUND_PENDING',
    });

    // Deciding twice is refused, and the patient can see the outcome.
    const again = await http().post(`/approvals/${pending.body[0].id}/decision`).set(asAdmin).send({ approved: false });
    expect(again.status).toBe(409);
    const transcript = await http().get(`/chat/${patient.sessionId}`).set('Authorization', `Bearer ${patient.token}`);
    expect(transcript.body[transcript.body.length - 1].content).toMatch(/has been cancelled/);
  });
});
