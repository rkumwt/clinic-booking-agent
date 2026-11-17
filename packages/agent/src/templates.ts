import type { BookingInfo } from './backend';
import type { Flow } from './prompts';
import type { Progress } from './progress';
import type { Signals } from './signals';

// Messages written by code, not by the model. Used for (1) the outcome of a
// booking, cancellation or reschedule, where a wrong word matters most, and
// (2) the fallback when the model's output was rejected twice. Every fact in
// them comes straight from a tool result.

export function sayDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function sayTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const when = (b: { date: string; time: string }) => `${sayDate(b.date)} at ${sayTime(b.time)}`;

export function bookingConfirmed(b: BookingInfo): string {
  return `Your appointment is booked. ${b.doctorName} (${b.specialization}) on ${when(b)}. The fee is ₹${b.feeInr}. Your booking ID is ${b.bookingId}. The next step is payment; would you like the payment details?`;
}

/** The reply after a cancel or reschedule tool call, including a staff rejection. */
export function changeOutcome(change: NonNullable<Progress['change']>): string {
  if (change.outcome === 'REJECTED_BY_STAFF') {
    return `I am sorry, the clinic staff did not approve this request, so your appointment is unchanged.${change.note ? ` Their note: ${change.note}` : ''} Is there anything else I can help with?`;
  }
  const b = change.booking;
  if (change.kind === 'cancel') {
    const refund = b?.paymentStatus === 'REFUND_PENDING' ? ' Your refund will be processed by the clinic staff.' : '';
    return `Your appointment${b ? ` with ${b.doctorName} on ${when(b)}` : ''} has been cancelled.${refund} Is there anything else I can help with?`;
  }
  return `Your appointment has been moved.${b ? ` You will now see ${b.doctorName} on ${when(b)}. Your booking ID is still ${b.bookingId}.` : ''}`;
}

const ASK_LOOKUP = 'Could you give me your booking ID (it looks like BK-7K4Q2M) and the mobile number used for the booking?';

function offerTimes(p: Progress, s?: Signals): string {
  const { date, slots } = p.slots!;
  const missed = s?.times.length && !slots.some((slot) => s.times.includes(slot.time));
  const sorry = missed && slots.length ? 'Sorry, that time is not free. ' : '';
  if (slots.length === 0) return `There are no free times on ${sayDate(date)}. Which other date would suit you?`;
  const times = slots.slice(0, 5).map((s) => sayTime(s.time));
  return `${sorry}On ${sayDate(date)} these times are free: ${times.join(', ')}. Which time would you like?`;
}

/**
 * A safe next message for the current step, used when the model could not
 * produce an acceptable one. It keeps the conversation moving, so a weak model
 * degrades into a scripted assistant rather than a dead end or a lie.
 */
export function scriptedReply(flow: Flow, p: Progress, s: Signals): string {
  if (flow === 'booking') {
    if (p.held) {
      const reserved = `I have reserved ${sayTime(p.held.time)} on ${sayDate(p.held.date)} with ${p.held.doctorName}.`;
      if (!s.name) return `${reserved} May I have your full name?`;
      if (!s.phone) return `Thank you, ${s.name}. What is your 10-digit mobile number?`;
      return `To confirm: ${p.held.doctorName} on ${when(p.held)}, fee ₹${p.held.feeInr}. Shall I confirm this booking?`;
    }
    if (p.slots) return offerTimes(p, s);
    if (p.doctors?.length === 1) {
      const d = p.doctors[0];
      return `${d.name} (${d.specialization}) is available, and the fee is ₹${d.feeInr}. Which date would you prefer?`;
    }
    if (p.doctors?.length) {
      return `We have ${p.doctors.map((d) => `${d.name} (${d.specialization}, ₹${d.feeInr})`).join('; ')}. Which doctor would you like to see?`;
    }
    return 'What kind of doctor would you like to see?';
  }

  if (flow === 'reschedule') {
    if (!p.lookup) return ASK_LOOKUP;
    if (p.held) {
      return `To confirm: move your appointment with ${p.lookup.booking.doctorName} from ${when(p.lookup.booking)} to ${when(p.held)}. Shall I confirm this change?`;
    }
    if (p.slots) return offerTimes(p, s);
    return `I found your appointment with ${p.lookup.booking.doctorName} on ${when(p.lookup.booking)}. Which new date would you prefer?`;
  }

  if (flow === 'cancel') {
    if (!p.lookup) return ASK_LOOKUP;
    return `I found your appointment with ${p.lookup.booking.doctorName} on ${when(p.lookup.booking)}. Are you sure you want to cancel this appointment?`;
  }

  // payment
  if (p.payment) return p.payment.url ? `${p.payment.message} ${p.payment.url}` : p.payment.message;
  if (!p.lookup && !p.booking) return ASK_LOOKUP;
  return 'Could you confirm the mobile number used for the booking, so I can fetch the payment details?';
}
