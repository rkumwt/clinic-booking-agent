import type { BookingInfo, FaqHit } from './backend';
import { resolveDates } from './dates';
import type { Progress } from './progress';
import type { Signals } from './signals';

export const INTENTS = ['faq', 'booking', 'reschedule', 'cancel', 'payment', 'handoff'] as const;
export type Intent = (typeof INTENTS)[number];
export type Flow = Exclude<Intent, 'faq' | 'handoff'>;

/**
 * Small models are bad at date arithmetic ("next Friday"), so the prompt
 * carries a ready-made calendar for the booking window instead.
 */
export function dateContext(now: Date, timezone: string, days = 14): string {
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, ...opts }).format(d);
  const day = (d: Date) => `${fmt(d, { weekday: 'long' })} ${fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' })}`;
  const upcoming = Array.from({ length: days }, (_, i) => day(new Date(now.getTime() + (i + 1) * 86_400_000)));
  // No clock time here: this block changes once a day, so the start of the
  // prompt stays identical between turns and the provider can reuse its cache.
  return [
    `Today is ${day(now)} (${timezone}).`,
    `Tomorrow is ${upcoming[0]}.`,
    `Calendar for your reference only (never read this list out): ${upcoming.join(', ')}.`,
  ].join('\n');
}

function clock(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

const RULES = `You are the appointment assistant for CityCare Clinic. You talk to patients by chat.

Rules you must always follow:
- Never invent doctors, appointment times, fees, booking IDs or payment links. Every such fact must come from a tool result or from the STATUS section below.
- Ask for one missing detail at a time. When you need a date, just ask "Which date would you prefer?" without listing dates.
- Never say "please hold", "one moment" or "let me check". Either call the tool in this turn or ask the patient a question.
- Keep replies short and friendly: one to three sentences, plain text, no markdown.
- Say dates in words (for example "Wednesday 18 November") and times in 12-hour form (for example "10:30 AM").
- Never show slotId or doctorId values to the patient.
- You are not a doctor. Do not give medical advice. For an emergency, tell the patient to call 108 and use transferToHuman.
- If a tool returns an error, explain it simply and offer the next step. Do not pretend it worked.
- Only help with this clinic. Politely decline anything else.`;

const describe = (b: BookingInfo) =>
  `booking ID ${b.bookingId}, ${b.doctorName} (${b.specialization}), ${b.date} at ${b.time}, fee ₹${b.feeInr}, patient ${b.patientName}, status ${b.status}, payment ${b.paymentStatus}`;

const slotLines = (p: Progress) =>
  p.slots!.slots.map((s) => `- ${s.time} (slotId=${s.slotId})`).join('\n');

const LOOKUP_STEP = `STATUS: The booking has not been looked up yet.
YOUR NEXT STEP:
a) If you do not have the booking ID (it looks like BK-7K4Q2M), ask for it.
b) If you do not have the mobile number used for the booking, ask for it.
c) Once you have both, call getBookingStatus. Do not describe the booking before the tool returns it.`;

/**
 * The model is told only where the conversation stands and what to do next,
 * rebuilt every turn from real tool results. A long numbered procedure works
 * for large models; small ones skip steps, so the code keeps track instead.
 */
export function stepFor(flow: Flow, p: Progress): string {
  switch (flow) {
    case 'booking': {
      if (p.booking && !p.doctors && !p.slots && !p.held) {
        return `STATUS: The booking is complete: ${describe(p.booking)}.
YOUR NEXT STEP: Tell the patient it is booked, give the booking ID exactly as written, and say that payment is the next step. Do not call a tool, unless the patient now asks for another appointment, in which case call searchDoctors.`;
      }
      if (p.held) {
        return `STATUS: A slot is reserved for ${p.held.holdMinutes} minutes: ${p.held.doctorName}, ${p.held.date} at ${p.held.time}, fee ₹${p.held.feeInr}. slotId=${p.held.slotId}
YOUR NEXT STEP, one message at a time:
a) If you do not have the patient's full name, ask for it.
b) If you do not have their 10-digit mobile number, ask for it.
c) If you have both, read back the doctor, date, time and fee, then ask "Shall I confirm this booking?"
d) If the patient has just said yes to that question, call confirmBooking with slotId="${p.held.slotId}", their name and their phone.
Never say the booking is confirmed until confirmBooking has returned a booking ID. If the patient wants a different time, call holdSlot for the new one.`;
      }
      if (p.slots) {
        if (p.slots.slots.length === 0) {
          return `STATUS: There are no free times for doctorId=${p.slots.doctorId} on ${p.slots.date}.
YOUR NEXT STEP: Tell the patient that day is full and ask for another date. When they give one, call getAvailableSlots with doctorId="${p.slots.doctorId}".`;
        }
        return `STATUS: Free times for doctorId=${p.slots.doctorId} on ${p.slots.date}:
${slotLines(p)}
YOUR NEXT STEP: If the patient has picked one of these times, call holdSlot with its slotId. Otherwise offer up to five of them and ask which they prefer. Never offer a time that is not in this list. For a different date, call getAvailableSlots again.`;
      }
      if (p.doctors?.length) {
        return `STATUS: Doctors found:
${p.doctors.map((d) => `- ${d.name}, ${d.specialization}, fee ₹${d.feeInr} (doctorId=${d.doctorId})`).join('\n')}
YOUR NEXT STEP:
a) If it is not clear which of these doctors the patient wants, say which ones fit and ask.
b) If the doctor is clear but you do not know the date, name the doctor and the fee and ask which date they prefer.
c) If you know both the doctor and the date, call getAvailableSlots with that doctorId and the date as YYYY-MM-DD.
Only mention doctors from this list, with names spelled exactly as shown.`;
      }
      return `STATUS: Nothing has been looked up yet.
YOUR NEXT STEP: Call searchDoctors now. Put the patient's own words about what they need ("heart", "skin", "child", a doctor's name) in the specialization or name field, or call it with no arguments to list everyone. Do not name any doctor before the tool returns.`;
    }

    case 'reschedule': {
      if (p.change?.kind === 'reschedule') return changeStep(p, 'moved');
      if (!p.lookup) return LOOKUP_STEP;
      const base = `STATUS: Booking found: ${describe(p.lookup.booking)}. doctorId=${p.lookup.booking.doctorId}`;
      if (p.held) {
        return `${base}
New slot reserved: ${p.held.date} at ${p.held.time}. slotId=${p.held.slotId}
YOUR NEXT STEP: Read back the old and the new date and time and ask the patient to confirm. If they have just said yes, call rescheduleBooking with bookingId="${p.lookup.booking.bookingId}", phone="${p.lookup.phone}" and newSlotId="${p.held.slotId}".`;
      }
      if (p.slots?.slots.length) {
        return `${base}
Free times on ${p.slots.date}:
${slotLines(p)}
YOUR NEXT STEP: If the patient has picked one of these times, call holdSlot with its slotId. Otherwise offer up to five of them. Never offer a time that is not in this list.`;
      }
      return `${base}
YOUR NEXT STEP: Ask which new date they would like. When you know it, call getAvailableSlots with doctorId="${p.lookup.booking.doctorId}" and the date as YYYY-MM-DD. An appointment can only move to the same doctor.`;
    }

    case 'cancel': {
      if (p.change?.kind === 'cancel') return changeStep(p, 'cancelled');
      if (!p.lookup) return LOOKUP_STEP;
      if (p.lookup.booking.status === 'CANCELLED') {
        return `STATUS: Booking found, and it is already cancelled: ${describe(p.lookup.booking)}.
YOUR NEXT STEP: Tell the patient this appointment is already cancelled.`;
      }
      return `STATUS: Booking found: ${describe(p.lookup.booking)}.
YOUR NEXT STEP: Read back the doctor, date and time and ask "Are you sure you want to cancel this appointment?" If the patient has just said yes to that, call cancelBooking with bookingId="${p.lookup.booking.bookingId}" and phone="${p.lookup.phone}". Refunds are never automatic; do not promise one.`;
    }

    case 'payment': {
      if (p.payment) {
        return `STATUS: Payment information from the system: ${JSON.stringify(p.payment)}
YOUR NEXT STEP: Tell the patient exactly this. Give a link only if one is shown here.`;
      }
      // A booking made earlier in this same chat can be paid without asking for details again.
      const known = p.lookup?.booking ?? p.booking;
      if (!known) return LOOKUP_STEP;
      return `STATUS: Booking: ${describe(known)}.
YOUR NEXT STEP: Call createPaymentLink with bookingId="${known.bookingId}"${p.lookup ? ` and phone="${p.lookup.phone}"` : ' and the phone number the patient gave when booking'}.`;
    }
  }
}

/**
 * Small models tend to lag one step behind: the patient says "11 AM works" and
 * the model lists the times again. These hints connect what the patient has
 * already said to the exact tool call that is due.
 */
export function hintsFor(flow: Flow, p: Progress, s: Signals): string[] {
  const hints: string[] = [];
  const confirmed = s.saidYes && s.askedToConfirm;

  if ((flow === 'booking' || flow === 'reschedule') && p.slots?.slots.length && !p.held) {
    const match = p.slots.slots.find((slot) => s.times.includes(slot.time));
    if (match) {
      hints.push(`The patient asked for ${match.time}, which is free. Call holdSlot with slotId="${match.slotId}" now.`);
    } else if (s.times.length) {
      hints.push('The time the patient asked for is not free on this date. Say so and offer times from the list.');
    }
  }

  if (flow === 'booking' && p.held) {
    if (s.phone) hints.push(`The patient's mobile number is ${s.phone}. Do not ask for it again.`);
    if (s.phone && confirmed) {
      hints.push(
        `The patient has said yes. Call confirmBooking now with slotId="${p.held.slotId}", phone="${s.phone}" and the name they gave.`,
      );
    }
  }

  if (flow !== 'booking' && !p.lookup && s.phone) {
    hints.push(`The patient's mobile number is ${s.phone}.`);
  }
  if (flow === 'reschedule' && p.lookup && p.held && confirmed) {
    hints.push(
      `The patient has said yes. Call rescheduleBooking now with bookingId="${p.lookup.booking.bookingId}", phone="${p.lookup.phone}" and newSlotId="${p.held.slotId}".`,
    );
  }
  if (flow === 'cancel' && p.lookup && !p.change && confirmed) {
    hints.push(
      `The patient has said yes. Call cancelBooking now with bookingId="${p.lookup.booking.bookingId}" and phone="${p.lookup.phone}".`,
    );
  }
  return hints;
}

function changeStep(p: Progress, done: string): string {
  const change = p.change!;
  if (change.outcome === 'REJECTED_BY_STAFF') {
    return `STATUS: The clinic staff did not approve this request. Their note: "${change.note ?? 'none'}". The appointment is unchanged.
YOUR NEXT STEP: Tell the patient kindly that the request was not approved, pass on the note, and offer to help with something else.`;
  }
  return `STATUS: Done. The appointment has been ${done}: ${change.booking ? describe(change.booking) : ''}.
YOUR NEXT STEP: Tell the patient it is ${done} and give the details shown here. Do not call a tool.`;
}

export function flowPrompt(
  flow: Flow,
  progress: Progress,
  now: Date,
  timezone: string,
  lastPatientMessage = '',
  signals?: Signals,
): string {
  const hintLines = signals ? hintsFor(flow, progress, signals) : [];
  const hintBlock = hintLines.length
    ? `\nHINTS, worked out from what the patient already said:\n- ${hintLines.join('\n- ')}`
    : '';
  const hints = resolveDates(lastPatientMessage, now, timezone);
  const dateHint = hints.length
    ? `\nDATE HINT: in the patient's latest message, ${hints.map((h) => `"${h.phrase}" means ${h.date}`).join(' and ')}.`
    : '';
  // Static text first, then what changes every turn.
  return `${RULES}\n\n${dateContext(now, timezone)}\n\nThe time now is ${clock(now, timezone)}.\n${stepFor(flow, progress)}${dateHint}${hintBlock}`;
}

export function faqPrompt(hits: FaqHit[]): string {
  const context = hits.length
    ? hits.map((h) => `[${h.title}]\n${h.content}`).join('\n\n')
    : '(no matching clinic information was found)';
  return `${RULES}

Your task now: answer the patient's question using only the clinic information below.
If the answer is not there, say you are not sure and offer to connect them to the clinic staff. Do not guess.
If they are just greeting you, greet them and say you can answer questions about the clinic and book, move or cancel appointments.

Clinic information:
${context}`;
}

export function routerPrompt(currentIntent: Intent | undefined, transcript: string): string {
  return `Classify what the patient wants in a clinic chat. Reply with exactly one word from this list:

booking - find a doctor, ask which doctors or times are available, or book a new appointment
reschedule - move an existing appointment to another time
cancel - cancel an existing appointment, or ask for a refund
payment - pay for a booking or ask for a payment link
handoff - asks for a human, is angry, or describes a medical emergency
faq - anything else: clinic hours, address, fees, policies, what to bring, greetings

The conversation was last about: ${currentIntent ?? 'nothing yet'}.
If the patient is simply answering the assistant's last question (a name, a phone number, a date, a time, "yes", "no"), reply with that same word.

Conversation:
${transcript}

One word:`;
}

export const HANDOFF_MESSAGE =
  'I am connecting you with our clinic staff, who will take it from here. If this is a medical emergency, please call 108 right away.';

export const APPROVAL_PENDING_MESSAGE =
  'I have sent your request to the clinic staff for approval. You will see their answer here as soon as they decide.';
