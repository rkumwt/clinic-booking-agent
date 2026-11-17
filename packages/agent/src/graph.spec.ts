import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createClinicAgent } from './graph';
import { InMemoryClinic, ScriptedModel, ScriptedStep, systemText } from './testing';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-17T04:30:00Z'); // Tuesday 17 November 2026, 10:00 IST

function setup(respond: (messages: BaseMessage[]) => ScriptedStep) {
  const clinic = new InMemoryClinic();
  const model = new ScriptedModel(respond);
  const agent = createClinicAgent({
    llm: model.asChatModel(),
    backend: clinic,
    checkpointer: new MemorySaver(),
    timezone: TZ,
    now: () => NOW,
  });
  const config = { configurable: { thread_id: 'thread-test-0001' } };

  const say = async (text: string) => {
    const result = await agent.invoke({ messages: [new HumanMessage(text)] }, config);
    return { reply: String(result.messages[result.messages.length - 1].content), intent: result.intent };
  };
  const interrupts = async () => (await agent.getState(config)).tasks.flatMap((t) => t.interrupts ?? []);
  return { clinic, model, agent, config, say, interrupts };
}

/** A model that only does what the fast path cannot: search, and ask plain questions. */
const helpfulModel = (messages: BaseMessage[]): ScriptedStep => {
  const system = systemText(messages);
  if (system.includes('Call searchDoctors now')) return { tool: 'searchDoctors', args: { specialization: 'heart' } };
  if (system.includes('A slot is reserved')) {
    if (!system.includes('mobile number is')) return 'May I have your full name?';
    return 'Dr. Rohan Mehta on Wednesday 18 November at 11:00 AM, fee ₹1200. Shall I confirm this booking?';
  }
  if (system.includes('The booking has not been looked up yet')) return 'What is your booking ID and mobile number?';
  if (system.includes('Booking found')) return 'Are you sure you want to cancel this appointment?';
  return 'Which date would you prefer?';
};

describe('clinic agent graph', () => {
  it('books an appointment end to end', async () => {
    const { clinic, say } = setup(helpfulModel);

    expect((await say('I want to book an appointment with a heart doctor')).intent).toBe('booking');
    await say('tomorrow'); // fast path: getAvailableSlots for 2026-11-18
    await say('11:00 AM works'); // fast path: holdSlot
    expect(clinic.held.size).toBe(1);
    await say('Asha Verma');
    await say('9876501234');
    const done = await say('yes please confirm'); // fast path: confirmBooking

    expect(clinic.bookings).toHaveLength(1);
    expect(clinic.bookings[0]).toMatchObject({
      doctorName: 'Dr. Rohan Mehta',
      date: '2026-11-18',
      time: '11:00',
      patientName: 'Asha Verma',
      phone: '+919876501234',
    });
    // The confirmation is a template built from the tool result.
    expect(done.reply).toContain(clinic.bookings[0].bookingId);
    expect(done.reply).toContain('Wednesday 18 November at 11:00 AM');
  });

  it('never tells the patient about a booking that was not made', async () => {
    // A model that skips every tool and simply claims success.
    const { clinic, say } = setup(() => 'Your appointment is booked with Dr. Rohan Tha. Your booking ID is 1234567890.');
    const { reply } = await say('I want to book an appointment with a heart doctor');

    expect(clinic.bookings).toHaveLength(0);
    expect(reply).not.toMatch(/booked|1234567890|Rohan Tha/);
    expect(reply).toBe('What kind of doctor would you like to see?');
  });

  it('refuses to book with details the patient never gave', async () => {
    // Behaves until a slot is held, then tries to confirm with invented details.
    const { clinic, say } = setup((messages) => {
      const system = systemText(messages);
      if (system.includes('A slot is reserved')) {
        const slotId = system.match(/slotId=(\S+)/)![1];
        return { tool: 'confirmBooking', args: { slotId, patientName: '[Patient Name]', phone: '9999999999' } };
      }
      return helpfulModel(messages);
    });

    await say('I want to book an appointment with a heart doctor');
    await say('tomorrow');
    const { reply } = await say('11:00 AM works');

    expect(clinic.bookings).toHaveLength(0);
    expect(reply).toMatch(/May I have your full name\?/); // scripted fallback keeps the conversation moving
  });

  it('does not hold a different time from the one the patient asked for', async () => {
    const { clinic, say } = setup((messages) => {
      const system = systemText(messages);
      const other = system.match(/- 11:30 \(slotId=(\S+)\)/);
      if (other) return { tool: 'holdSlot', args: { slotId: other[1] } };
      return helpfulModel(messages);
    });
    await say('I want to book an appointment with a heart doctor');
    await say('tomorrow');
    const { reply } = await say('4:15 pm'); // not a free time

    expect(clinic.held.size).toBe(0);
    expect(reply).toMatch(/these times are free/);
  });

  it('keeps a mid-flow answer in the same flow without calling the router model', async () => {
    const { model, say } = setup(helpfulModel);
    await say('I want to book an appointment with a heart doctor');
    const before = model.calls.length;
    const { intent } = await say('tomorrow');

    expect(intent).toBe('booking');
    // No classifier call was needed for "tomorrow", and none for the slot lookup either.
    const routerCalls = model.calls.slice(before).filter((m) => String(m[0].content).startsWith('Classify'));
    expect(routerCalls).toHaveLength(0);
  });

  it('answers a clinic question from the FAQ', async () => {
    const { say } = setup((messages) => {
      if (String(messages[0].content).startsWith('Classify')) return 'faq';
      return systemText(messages).includes('9:00 AM to 8:00 PM') ? 'We are open 9:00 AM to 8:00 PM.' : 'I am not sure.';
    });
    const { reply, intent } = await say('What are your timings?');
    expect(intent).toBe('faq');
    expect(reply).toBe('We are open 9:00 AM to 8:00 PM.');
  });

  it('hands off to a human without calling the model', async () => {
    const { clinic, model, say } = setup(() => 'unused');
    const { reply, intent } = await say('I want to talk to a real person');
    expect(intent).toBe('handoff');
    expect(clinic.handoffs).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(reply).toMatch(/clinic staff/);
  });

  describe('changes that need staff approval', () => {
    async function bookedAndProtected() {
      const ctx = setup(helpfulModel);
      await ctx.say('I want to book an appointment with a heart doctor');
      await ctx.say('tomorrow');
      await ctx.say('11:00 AM');
      await ctx.say('Asha Verma');
      await ctx.say('9876501234');
      await ctx.say('yes');
      const booking = ctx.clinic.bookings[0];
      ctx.clinic.needsApproval.add(booking.bookingId);

      await ctx.say('I want to cancel my appointment');
      await ctx.say(booking.bookingId); // phone is already known: fast path looks the booking up
      await ctx.say('yes'); // fast path: cancelBooking -> interrupt
      return { ...ctx, booking };
    }

    it('pauses on an interrupt instead of cancelling', async () => {
      const { booking, interrupts } = await bookedAndProtected();
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(await interrupts()).toEqual([
        expect.objectContaining({ value: expect.objectContaining({ type: 'CANCELLATION', bookingId: booking.bookingId }) }),
      ]);
    });

    it('cancels when staff approve', async () => {
      const { agent, config, booking } = await bookedAndProtected();
      const result = await agent.invoke(new Command({ resume: { approved: true } }), config);
      expect(booking.status).toBe('CANCELLED');
      expect(String(result.messages[result.messages.length - 1].content)).toMatch(/has been cancelled/);
    });

    it('leaves the booking alone when staff reject, and passes on the note', async () => {
      const { agent, config, booking } = await bookedAndProtected();
      const result = await agent.invoke(new Command({ resume: { approved: false, note: 'Too late to cancel.' } }), config);
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(String(result.messages[result.messages.length - 1].content)).toMatch(/did not approve.*Too late to cancel/);
    });
  });
});
