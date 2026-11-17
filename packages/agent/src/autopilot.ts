import type { ProposedToolCall } from './guard';
import type { Flow } from './prompts';
import type { Progress } from './progress';
import type { Signals } from './signals';

/**
 * The fast path. When the conversation state leaves exactly one sensible next
 * tool call, the code makes it and the model is not asked.
 *
 * Example: free times are listed and the patient types "11 AM". The only
 * correct move is holdSlot for the 11:00 slot. Asking a model to work that
 * out costs a round trip and, with a small model, often produces something
 * else. The call still goes through the normal tool node, so it is logged
 * and checkpointed like any other.
 *
 * Returns undefined whenever judgement is needed (which doctor? what did the
 * patient mean?), and the model takes over.
 */
export function nextCertainCall(
  flow: Flow,
  p: Progress,
  s: Signals,
): ProposedToolCall | undefined {
  const requestedDate = s.dates[0];
  const confirmed = s.saidYes && s.askedToConfirm;

  // Existing-booking flows start by finding the booking.
  if (flow !== 'booking' && !p.lookup && !(flow === 'payment' && p.booking)) {
    if (s.bookingReference && s.phone) {
      return { name: 'getBookingStatus', args: { bookingId: s.bookingReference, phone: s.phone } };
    }
    return undefined;
  }

  if (flow === 'booking' || flow === 'reschedule') {
    const doctorId =
      flow === 'reschedule' ? p.lookup?.booking.doctorId : p.doctors?.length === 1 ? p.doctors[0].doctorId : p.slots?.doctorId;
    const finished = flow === 'reschedule' ? p.change?.kind === 'reschedule' : false;

    // A date for a known doctor, and no times fetched for that date yet.
    if (!finished && !p.held && doctorId && requestedDate && p.slots?.date !== requestedDate) {
      return { name: 'getAvailableSlots', args: { doctorId, date: requestedDate } };
    }
    // The patient picked one of the listed times.
    if (!finished && !p.held && p.slots) {
      const picked = p.slots.slots.find((slot) => s.times.includes(slot.time));
      if (picked) return { name: 'holdSlot', args: { slotId: picked.slotId } };
    }
  }

  if (flow === 'booking' && p.held && s.name && s.phone && confirmed) {
    return { name: 'confirmBooking', args: { slotId: p.held.slotId, patientName: s.name, phone: s.phone } };
  }
  if (flow === 'reschedule' && p.lookup && p.held && confirmed && p.change?.kind !== 'reschedule') {
    return {
      name: 'rescheduleBooking',
      args: { bookingId: p.lookup.booking.bookingId, phone: p.lookup.phone, newSlotId: p.held.slotId },
    };
  }
  if (flow === 'cancel' && p.lookup && confirmed && !p.change && p.lookup.booking.status !== 'CANCELLED') {
    return { name: 'cancelBooking', args: { bookingId: p.lookup.booking.bookingId, phone: p.lookup.phone } };
  }
  if (flow === 'payment' && !p.payment) {
    const booking = p.lookup?.booking ?? p.booking;
    const phone = p.lookup?.phone ?? s.phone;
    if (booking && phone) return { name: 'createPaymentLink', args: { bookingId: booking.bookingId, phone } };
  }
  return undefined;
}
