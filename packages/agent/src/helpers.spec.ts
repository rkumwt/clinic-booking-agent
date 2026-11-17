import { resolveDates } from './dates';
import { GuardContext, checkReply, checkToolCalls } from './guard';
import { keywordIntent, parseIntent } from './graph';
import { Progress } from './progress';
import { Signals, parseTimes, readSignals } from './signals';

const TZ = 'Asia/Kolkata';
// Tuesday 17 November 2026, 10:00 in India.
const NOW = new Date('2026-11-17T04:30:00Z');

describe('resolveDates', () => {
  const dateOf = (text: string) => resolveDates(text, NOW, TZ).map((h) => h.date);

  it('resolves relative days', () => {
    expect(dateOf('tomorrow please')).toEqual(['2026-11-18']);
    expect(dateOf('day after tomorrow')).toEqual(['2026-11-19']);
    expect(dateOf('can I come today?')).toEqual(['2026-11-17']);
  });

  it('resolves a weekday to its next occurrence, never today', () => {
    expect(dateOf('this thursday')).toEqual(['2026-11-19']);
    expect(dateOf('next Tuesday')).toEqual(['2026-11-24']);
    expect(dateOf('sat works')).toEqual(['2026-11-21']);
  });

  it('resolves calendar dates and rolls into next year when needed', () => {
    expect(dateOf('18 Nov')).toEqual(['2026-11-18']);
    expect(dateOf('on the 25th of November')).toEqual(['2026-11-25']);
    expect(dateOf('Jan 5')).toEqual(['2027-01-05']);
    expect(dateOf('2026-11-20')).toEqual(['2026-11-20']);
  });

  it('finds nothing in a message without a date', () => {
    expect(dateOf('Asha Verma')).toEqual([]);
  });
});

describe('signals', () => {
  it('parses clock times', () => {
    expect(parseTimes('11:00 AM works')).toEqual(['11:00']);
    expect(parseTimes('2 pm')).toEqual(['14:00']);
    expect(parseTimes('12:20 pm')).toEqual(['12:20']);
    expect(parseTimes('maybe 3:30')).toEqual(['03:30', '15:30']);
    expect(parseTimes('I have 2 kids and 18 questions')).toEqual([]);
  });

  it('reads name, phone, booking reference and confirmation', () => {
    const s = readSignals([
      { role: 'assistant', text: 'May I have your full name?' },
      { role: 'patient', text: 'Asha Verma' },
      { role: 'assistant', text: 'And your mobile number?' },
      { role: 'patient', text: '98765 01234, booking bk-7k4q2m' },
      { role: 'assistant', text: 'Shall I confirm this booking?' },
      { role: 'patient', text: 'yes please' },
    ]);
    expect(s).toMatchObject({
      name: 'Asha Verma',
      phone: '98765 01234',
      bookingReference: 'BK-7K4Q2M',
      saidYes: true,
      askedToConfirm: true,
    });
  });

  it('understands a stated name and does not mistake other answers for one', () => {
    const stated = readSignals([{ role: 'patient', text: 'my name is Ravi Kumar and my number is 9811122334' }]);
    expect(stated.name).toBe('Ravi Kumar');

    const notName = readSignals([
      { role: 'assistant', text: 'May I have your full name?' },
      { role: 'patient', text: 'tomorrow please' },
    ]);
    expect(notName.name).toBeUndefined();
  });

  it('does not treat "no" or a change of mind as a yes', () => {
    const s = readSignals([
      { role: 'assistant', text: 'Shall I confirm this booking?' },
      { role: 'patient', text: 'ok but change the time' },
    ]);
    expect(s.saidYes).toBe(false);
  });
});

describe('router helpers', () => {
  it('routes unmistakable wording without a model', () => {
    expect(keywordIntent('I want to cancel my appointment')).toBe('cancel');
    expect(keywordIntent('need to reschedule')).toBe('reschedule');
    expect(keywordIntent('let me talk to a real person')).toBe('handoff');
    expect(keywordIntent('I want to book an appointment with a heart doctor')).toBe('booking');
    expect(keywordIntent('tomorrow')).toBeUndefined();
  });

  it('parses a chatty classifier answer and falls back when unclear', () => {
    expect(parseIntent('Booking.', 'faq')).toBe('booking');
    expect(parseIntent('The answer is: cancel (not faq)', 'faq')).toBe('cancel');
    expect(parseIntent('hmm', 'reschedule')).toBe('reschedule');
  });
});

const held = { slotId: 's1', date: '2026-11-18', time: '11:00', doctorName: 'Dr. Rohan Mehta', feeInr: 1200, holdMinutes: 10 };
const signals = (over: Partial<Signals> = {}): Signals => ({ times: [], dates: [], saidYes: false, askedToConfirm: false, ...over });

function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return { flow: 'booking', facts: [], progress: {}, signals: signals(), patientText: '', ...over };
}

describe('checkReply', () => {
  const doctorFact = {
    name: 'searchDoctors',
    args: {},
    result: { doctors: [{ doctorId: 'd1', name: 'Dr. Rohan Mehta', specialization: 'Cardiology', feeInr: 1200 }] },
  };

  it('blocks a booking confirmation that no tool produced', () => {
    const problems = checkReply('Your appointment is booked. Your booking ID is 1234567890.', ctx());
    expect(problems.join(' ')).toMatch(/confirmBooking has not succeeded/);
  });

  it('blocks doctors, booking IDs, links and phone numbers that did not come from a tool', () => {
    expect(checkReply('Dr. Rohan Tha can see you.', ctx({ facts: [doctorFact] }))).toHaveLength(1);
    expect(checkReply('Your ID is BK-ABC123.', ctx({ flow: 'payment' }))).toHaveLength(1);
    expect(checkReply('Pay here: https://pay.example/abc', ctx({ flow: 'payment' }))).toHaveLength(1);
    expect(checkReply('Call us on 123-456-7890.', ctx({ flow: 'payment' }))).toHaveLength(1);
  });

  it('blocks stalling, leaked internal IDs and times offered before slots are fetched', () => {
    expect(checkReply('Please hold while I check the times.', ctx())).not.toHaveLength(0);
    expect(checkReply('Which slotId would you like?', ctx({ progress: { held } }))).not.toHaveLength(0);
    expect(checkReply('11:00 AM is available.', ctx())).not.toHaveLength(0);
  });

  it('blocks saying a time is free when the patient asked for one that is not listed', () => {
    const slots = { doctorId: 'd1', date: '2026-11-20', slots: [{ slotId: 's1', time: '10:20' }, { slotId: 's2', time: '10:40' }] };
    const asked = ctx({ progress: { slots }, signals: signals({ times: ['10:30'] }) });
    expect(checkReply('10:30 AM is available. Shall I reserve it?', asked)).not.toHaveLength(0);
    expect(checkReply('Sorry, 10:30 AM is not free. We have 10:20 AM or 10:40 AM.', asked)).toEqual([]);
  });

  it('allows a grounded reply', () => {
    const progress: Progress = { doctors: doctorFact.result.doctors };
    expect(checkReply('Dr. Rohan Mehta is our cardiologist. Which date would you prefer?', ctx({ facts: [doctorFact], progress }))).toEqual([]);
    // The patient's own number and booking ID may be repeated back.
    expect(
      checkReply('I could not find BK-ABC123 for 9876501234.', ctx({ flow: 'cancel', patientText: 'bk-abc123 9876501234' })),
    ).toEqual([]);
  });
});

describe('checkToolCalls', () => {
  const ready = ctx({
    progress: { held },
    signals: signals({ name: 'Asha Verma', phone: '9876501234', saidYes: true, askedToConfirm: true }),
    patientText: 'Asha Verma ; 9876501234 ; yes',
  });
  const confirm = (args: Record<string, unknown>) => [{ name: 'confirmBooking', args: { slotId: 's1', ...args } }];

  it('allows confirmBooking only with the patient’s own name, phone and a yes', () => {
    expect(checkToolCalls(confirm({ patientName: 'Asha Verma', phone: '9876501234' }), ready)).toEqual([]);
    expect(checkToolCalls(confirm({ patientName: '[Patient Name]', phone: '9876501234' }), ready)).toHaveLength(1);
    expect(checkToolCalls(confirm({ patientName: 'Asha Verma', phone: '+919999999999' }), ready)).toHaveLength(1);

    const notConfirmed = { ...ready, signals: { ...ready.signals, saidYes: false } };
    expect(checkToolCalls(confirm({ patientName: 'Asha Verma', phone: '9876501234' }), notConfirmed)).toHaveLength(1);
  });

  it('blocks confirmBooking for a slot that is not the one held', () => {
    expect(checkToolCalls([{ name: 'confirmBooking', args: { slotId: 'other', patientName: 'Asha Verma', phone: '9876501234' } }], ready)).toHaveLength(1);
    expect(checkToolCalls([{ name: 'confirmBooking', args: { patientName: 'Asha Verma', phone: '9876501234' } }], ready)).toHaveLength(1);
  });

  it('only holds a listed slot at the time the patient asked for', () => {
    const slots = { doctorId: 'd1', date: '2026-11-18', slots: [{ slotId: 's1', time: '11:00' }, { slotId: 's2', time: '11:30' }] };
    const hold = (slotId: string) => [{ name: 'holdSlot', args: { slotId } }];
    const asked = ctx({ progress: { slots }, signals: signals({ times: ['11:00'] }) });

    expect(checkToolCalls(hold('s1'), asked)).toEqual([]);
    expect(checkToolCalls(hold('s2'), asked)[0]).toMatch(/asked for 11:00, not 11:30/);
    expect(checkToolCalls(hold('made-up'), asked)).toHaveLength(1);
    expect(checkToolCalls(hold('s1'), ctx({ progress: { slots } }))[0]).toMatch(/has not chosen a time/);
  });

  it('only fetches slots for a known doctor on a date the patient named', () => {
    const doctors = [{ doctorId: 'd1', name: 'Dr. Rohan Mehta', specialization: 'Cardiology', feeInr: 1200 }];
    const fetch = (doctorId: string, date: string) => [{ name: 'getAvailableSlots', args: { doctorId, date } }];
    const asked = ctx({ progress: { doctors }, signals: signals({ dates: ['2026-11-20'] }) });

    expect(checkToolCalls(fetch('d1', '2026-11-20'), asked)).toEqual([]);
    expect(checkToolCalls(fetch('d1', '2026-11-25'), asked)[0]).toMatch(/asked for 2026-11-20, not 2026-11-25/);
    expect(checkToolCalls(fetch('made-up', '2026-11-20'), asked)).toHaveLength(1);
    expect(checkToolCalls(fetch('d1', '2026-11-20'), ctx({ progress: { doctors } }))[0]).toMatch(/has not said which date/);
  });

  it('requires a lookup and a yes before cancelling', () => {
    const booking = { bookingId: 'BK-ABC123', status: 'CONFIRMED', paymentStatus: 'PAID', doctorId: 'd1', doctorName: 'Dr. Rohan Mehta', specialization: 'Cardiology', date: '2026-11-18', time: '11:00', feeInr: 1200, patientName: 'Asha Verma' };
    const cancel = [{ name: 'cancelBooking', args: { bookingId: 'BK-ABC123', phone: '9876501234' } }];
    const lookedUp = { lookup: { booking, phone: '9876501234' } };

    expect(checkToolCalls(cancel, ctx({ flow: 'cancel' }))).toHaveLength(1);
    expect(checkToolCalls(cancel, ctx({ flow: 'cancel', progress: lookedUp }))).toHaveLength(1);
    expect(
      checkToolCalls(cancel, ctx({ flow: 'cancel', progress: lookedUp, signals: signals({ saidYes: true, askedToConfirm: true }) })),
    ).toEqual([]);
  });
});
