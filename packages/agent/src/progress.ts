import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { BookingInfo, DoctorInfo, HeldSlotInfo } from './backend';

// What has actually happened in this conversation, read back from tool
// results. The graph uses it for two things: to tell the model exactly which
// step it is on (prompts.ts), and to check the model's reply against reality
// (guard.ts). Neither relies on the model remembering or obeying anything.

export interface ToolFact {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** Every tool call that succeeded, oldest first. Calls that returned an error are left out. */
export function toolFacts(messages: BaseMessage[]): ToolFact[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const facts: ToolFact[] = [];

  for (const message of messages) {
    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (call.id) calls.set(call.id, { name: call.name, args: call.args });
      }
    } else if (message instanceof ToolMessage) {
      const call = calls.get(message.tool_call_id);
      if (!call) continue;
      try {
        const result = JSON.parse(String(message.content));
        if (result && typeof result === 'object' && !('error' in result)) facts.push({ ...call, result });
      } catch {
        // Not JSON: a schema validation error raised by the tool node. Not a fact.
      }
    }
  }
  return facts;
}

export interface SlotList {
  doctorId: string;
  date: string;
  slots: Array<{ slotId: string; time: string }>;
}

export interface Progress {
  doctors?: DoctorInfo[];
  slots?: SlotList;
  held?: HeldSlotInfo;
  /** A booking created in this conversation. */
  booking?: BookingInfo;
  /** An existing booking the patient looked up (reschedule, cancel, payment). */
  lookup?: { booking: BookingInfo; phone: string };
  /** Result of a finished cancel or reschedule, including a staff rejection. */
  change?: { kind: 'cancel' | 'reschedule'; outcome: string; booking?: BookingInfo; note?: string };
  payment?: { available: boolean; url?: string; amountInr?: number; message: string };
}

export function progressOf(facts: ToolFact[]): Progress {
  const progress: Progress = {};
  for (const fact of facts) {
    switch (fact.name) {
      case 'searchDoctors':
        progress.doctors = fact.result.doctors as DoctorInfo[];
        break;
      case 'getAvailableSlots':
        progress.slots = {
          doctorId: String(fact.args.doctorId),
          date: String(fact.result.date),
          slots: fact.result.slots as SlotList['slots'],
        };
        break;
      case 'holdSlot':
        progress.held = fact.result as unknown as HeldSlotInfo;
        break;
      case 'confirmBooking':
        // A finished booking closes the cycle; a later search starts a new one.
        progress.booking = fact.result as unknown as BookingInfo;
        progress.doctors = progress.slots = progress.held = undefined;
        break;
      case 'getBookingStatus':
        progress.lookup = { booking: fact.result as unknown as BookingInfo, phone: String(fact.args.phone) };
        progress.change = progress.payment = undefined;
        break;
      case 'cancelBooking':
      case 'rescheduleBooking':
        progress.change = {
          kind: fact.name === 'cancelBooking' ? 'cancel' : 'reschedule',
          outcome: String(fact.result.outcome),
          booking: fact.result.booking as BookingInfo | undefined,
          note: fact.result.note as string | undefined,
        };
        progress.held = progress.slots = undefined;
        break;
      case 'createPaymentLink':
        progress.payment = fact.result as unknown as Progress['payment'];
        break;
    }
  }
  return progress;
}
