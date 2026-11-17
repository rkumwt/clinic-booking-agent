import { PhoneSchema } from '@clinic/shared';
import type { Flow } from './prompts';
import type { Progress, ToolFact } from './progress';
import type { Signals } from './signals';

// "The model proposes, the code disposes." Nothing the model produces is
// trusted: a reply is checked against what the tools returned before the
// patient sees it, and a tool call is checked against what the patient said
// before it runs. Both checks are plain code, so they hold for any model.

export interface GuardContext {
  flow: Flow;
  facts: ToolFact[];
  progress: Progress;
  signals: Signals;
  /** Everything the patient typed in this conversation. */
  patientText: string;
}

export interface ProposedToolCall {
  name: string;
  args: Record<string, unknown>;
}

const BOOKING_CLAIM =
  /\b(booking id|booking reference|(is|has been|have been|are) (now |successfully )?(confirmed|booked)|(have|i've|i have) (confirmed|booked)|successfully booked|appointment is booked)\b/i;
const CANCEL_CLAIM = /\b((is|has been|have been) (now |successfully )?cancell?ed|(have|i've|i have) cancell?ed)\b/i;
const RESCHEDULE_CLAIM =
  /\b((is|has been|have been) (now |successfully )?(rescheduled|moved)|(have|i've|i have) (rescheduled|moved))\b/i;
const DOCTOR_NAME = /\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g;
const BOOKING_REFERENCE = /\bBK-?[A-Z0-9]{6}\b/gi;
const CLOCK_TIME = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/i;
const LINK = /https?:\/\/\S+/gi;
const LONG_NUMBER = /\+?\d[\d\s-]{8,}\d/g;
// "Please hold while I check" with no tool call: the turn ends and nothing happens.
const STALLING =
  /\b(hold (on|please)|please (hold|wait)|(one|just a) (moment|second|sec)|bear with me|let'?s (check|see|look|find)|let me (check|look|see|find|reserve|hold|confirm|book|cancel|pull)|i('ll| will| am going to) (now )?(check|look|find|reserve|hold|confirm|book|cancel|get|proceed)|while i (check|reserve|hold|look|confirm))\b/i;

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = (text: string) => text.replace(/\D/g, '');

function samePhone(a: unknown, b: string | undefined): boolean {
  const left = PhoneSchema.safeParse(String(a ?? ''));
  const right = PhoneSchema.safeParse(b ?? '');
  return left.success && right.success && left.data === right.data;
}

/** Reasons a reply must not be sent. An empty array means it is safe. */
export function checkReply(reply: string, ctx: GuardContext): string[] {
  const { flow, facts, progress, patientText } = ctx;
  const problems: string[] = [];
  const factText = JSON.stringify(facts);
  const known = squash(factText);

  if (flow === 'booking' && BOOKING_CLAIM.test(reply) && !progress.booking) {
    problems.push('You said the booking is confirmed or gave a booking ID, but confirmBooking has not succeeded.');
  }
  if (flow === 'cancel' && CANCEL_CLAIM.test(reply) && progress.change?.kind !== 'cancel') {
    problems.push('You said the appointment is cancelled, but cancelBooking has not succeeded.');
  }
  if (flow === 'reschedule' && RESCHEDULE_CLAIM.test(reply) && progress.change?.kind !== 'reschedule') {
    problems.push('You said the appointment was moved, but rescheduleBooking has not succeeded.');
  }

  for (const name of reply.match(DOCTOR_NAME) ?? []) {
    if (!known.includes(squash(name.replace(/^Dr\.?\s+/, '')))) {
      problems.push(`"${name}" is not a doctor returned by a tool. Use searchDoctors and copy names exactly.`);
    }
  }

  for (const reference of reply.match(BOOKING_REFERENCE) ?? []) {
    const ref = squash(reference);
    if (!known.includes(ref) && !squash(patientText).includes(ref)) {
      problems.push(`Booking ID "${reference}" did not come from a tool.`);
    }
  }

  for (const link of reply.match(LINK) ?? []) {
    if (!factText.includes(link.replace(/[.,)]+$/, ''))) {
      problems.push('You gave a link that did not come from a tool.');
    }
  }

  // Invented contact numbers ("call us on 123-456-7890").
  for (const number of reply.match(LONG_NUMBER) ?? []) {
    const d = digits(number);
    if (d.length >= 10 && !digits(patientText).includes(d.slice(-10)) && !digits(factText).includes(d.slice(-10))) {
      problems.push(`The number "${number.trim()}" did not come from the patient or a tool. Remove it.`);
    }
  }

  if (/\b(reserved|on hold|is held|holding (a|the|your))\b/i.test(reply) && !progress.held && !progress.booking) {
    problems.push('You said a slot is reserved, but holdSlot has not succeeded.');
  }
  if (/\b(slotId|doctorId|slot id|doctor id)\b/i.test(reply)) {
    problems.push('Never mention slotId or doctorId to the patient. Ask for a time instead.');
  }

  // The patient asked for a time that is not in the list: the reply must say so.
  const offered = progress.slots?.slots ?? [];
  const askedForUnlisted =
    offered.length > 0 && !progress.held && ctx.signals.times.length > 0 && !offered.some((slot) => ctx.signals.times.includes(slot.time));
  if (askedForUnlisted && !/\b(not|isn'?t|unavailable|sorry|unfortunately)\b/i.test(reply)) {
    problems.push('The time the patient asked for is not free. Say so plainly and offer times from the list.');
  }

  const hasTimes = progress.slots || progress.held || progress.booking || progress.lookup;
  if ((flow === 'booking' || flow === 'reschedule') && CLOCK_TIME.test(reply) && !hasTimes) {
    problems.push('You mentioned an appointment time before calling getAvailableSlots. Times must come from that tool.');
  }

  // Small models occasionally emit stray characters from other scripts mid-word.
  if (/[^\x00-\x7F\u20B9\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0-\u00FF]/.test(reply)) {
    problems.push('Your reply contains garbled characters. Write it again in plain English.');
  }

  if (STALLING.test(reply)) {
    problems.push(
      'You told the patient to wait but did not call a tool, so nothing would happen. Call the tool now, or ask a question.',
    );
  }

  return problems;
}

/**
 * Reasons a tool call must not run. This is what stops a model from booking
 * with a made-up name and phone number, holding a time the patient did not
 * ask for, or cancelling without a yes.
 */
export function checkToolCalls(calls: ProposedToolCall[], ctx: GuardContext): string[] {
  const { progress: p, signals: s, patientText } = ctx;
  const problems: string[] = [];
  const confirmed = s.saidYes && s.askedToConfirm;
  const said = patientText.toLowerCase();

  for (const { name, args } of calls) {
    switch (name) {
      case 'getAvailableSlots': {
        const knownDoctors = [
          ...(p.doctors?.map((d) => d.doctorId) ?? []),
          p.slots?.doctorId,
          p.lookup?.booking.doctorId,
        ];
        if (!knownDoctors.includes(String(args.doctorId))) {
          problems.push('getAvailableSlots: that doctorId did not come from a tool. Call searchDoctors first.');
        } else if (s.dates.length === 0) {
          problems.push('getAvailableSlots: the patient has not said which date. Ask "Which date would you prefer?"');
        } else if (!s.dates.includes(String(args.date))) {
          problems.push(`getAvailableSlots: the patient asked for ${s.dates[0]}, not ${args.date}. Use their date.`);
        }
        break;
      }

      case 'holdSlot': {
        const slot = p.slots?.slots.find((x) => x.slotId === args.slotId);
        if (!slot) {
          problems.push('holdSlot: that slotId is not in the current list of free times. Call getAvailableSlots first.');
        } else if (s.times.length === 0) {
          problems.push('holdSlot: the patient has not chosen a time yet. Offer the free times and ask which they want.');
        } else if (!s.times.includes(slot.time)) {
          problems.push(
            `holdSlot: the patient asked for ${s.times[0]}, not ${slot.time}. If their time is not free, say so and let them choose.`,
          );
        }
        break;
      }

      case 'confirmBooking': {
        if (!p.held?.slotId || args.slotId !== p.held.slotId) {
          problems.push('confirmBooking: this slot is not the one currently reserved. Call holdSlot first.');
          break;
        }
        const nameWords = String(args.patientName ?? '')
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((w) => w.length >= 2);
        if (nameWords.length === 0 || !nameWords.every((w) => said.includes(w))) {
          problems.push('confirmBooking: the patient has not given that name. Ask for their full name.');
        } else if (!samePhone(args.phone, s.phone)) {
          problems.push('confirmBooking: the patient has not given that mobile number. Ask for their 10-digit number.');
        } else if (!confirmed) {
          problems.push(
            'confirmBooking: the patient has not said yes yet. Read back the doctor, date, time and fee and ask "Shall I confirm this booking?"',
          );
        }
        break;
      }

      case 'getBookingStatus': {
        if (!squash(patientText).includes(squash(String(args.bookingId ?? '')).replace(/^bk/, ''))) {
          problems.push('getBookingStatus: the patient has not given that booking ID. Ask for it.');
        } else if (!samePhone(args.phone, s.phone)) {
          problems.push('getBookingStatus: the patient has not given that mobile number. Ask for it.');
        }
        break;
      }

      case 'cancelBooking':
      case 'rescheduleBooking': {
        if (!p.lookup || squash(String(args.bookingId)) !== squash(p.lookup.booking.bookingId)) {
          problems.push(`${name}: look the booking up with getBookingStatus first.`);
        } else if (name === 'rescheduleBooking' && (!p.held || args.newSlotId !== p.held.slotId)) {
          problems.push('rescheduleBooking: the new slot is not reserved. Call holdSlot for the time the patient picked.');
        } else if (!confirmed) {
          problems.push(`${name}: the patient has not said yes yet. Read back the details and ask them to confirm.`);
        }
        break;
      }

      case 'createPaymentLink': {
        const known = [p.lookup?.booking.bookingId, p.booking?.bookingId].filter(Boolean).map((b) => squash(b!));
        if (!known.includes(squash(String(args.bookingId)))) {
          problems.push('createPaymentLink: that booking ID did not come from a tool. Look the booking up first.');
        }
        break;
      }
    }
  }
  return problems;
}
