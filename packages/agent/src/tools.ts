import { PhoneSchema } from '@clinic/shared';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import type { ApprovalDecision, ApprovalInterrupt, ChangeResult, ClinicBackend, ToolContext } from './backend';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD, for example 2026-11-18');
const id = (what: string) => z.string().min(5).describe(`${what}, copied exactly from an earlier tool result`);
const phone = z.string().describe("The patient's 10-digit mobile number");

function contextOf(config: RunnableConfig): ToolContext {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== 'string') throw new Error('thread_id is required in the run config');
  return { threadId, channel: config.configurable?.channel ?? 'CHAT' };
}

const ok = (data: unknown) => JSON.stringify(data);

/** The tool result as the model sees it: the value itself, or `{ error }`. */
const unwrap = <T>(result: { value: T } | { error: string }) => ok('error' in result ? result : result.value);

/**
 * Backend failures (slot taken, booking not found, bad phone) come back to the
 * model as data, not exceptions, so it can explain the problem and try again.
 */
async function attempt<T>(run: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await run() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Something went wrong' };
  }
}

function normalisePhone(raw: string): string {
  const parsed = PhoneSchema.safeParse(raw);
  if (!parsed.success) throw new Error('That does not look like a valid 10-digit Indian mobile number. Ask for it again.');
  return parsed.data;
}

/**
 * Shared ending for cancel and reschedule. If the backend says a human must
 * approve, the graph pauses here via interrupt(). When an admin decides, the
 * graph resumes and this tool runs again from the top, which is safe because
 * the backend calls are idempotent.
 *
 * interrupt() works by throwing, so it must stay outside any try/catch.
 */
async function finishChange(
  first: { value: ChangeResult } | { error: string },
  type: ApprovalInterrupt['type'],
  retryApproved: () => Promise<ChangeResult>,
): Promise<string> {
  if ('error' in first) return ok(first);
  if (first.value.outcome === 'DONE') return ok(first.value);

  const request: ApprovalInterrupt = {
    type,
    bookingId: first.value.booking.bookingId,
    summary: first.value.reason,
  };
  const decision = interrupt<ApprovalInterrupt, ApprovalDecision>(request);

  if (!decision.approved) {
    return ok({ outcome: 'REJECTED_BY_STAFF', note: decision.note ?? 'The clinic did not approve this request.' });
  }
  const second = await attempt(retryApproved);
  return ok('error' in second ? second : { ...second.value, approvedByStaff: true });
}

export function createClinicTools(backend: ClinicBackend) {
  const searchDoctors = tool(
    async (input) => {
      const result = await attempt(() => backend.searchDoctors(input));
      if ('error' in result) return ok(result);
      return ok(result.value.length ? { doctors: result.value } : { doctors: [], note: 'No doctor matched.' });
    },
    {
      name: 'searchDoctors',
      description:
        'List the clinic’s doctors with their specialization and consultation fee. Call with no arguments to list every doctor. Always use this before naming a doctor or a fee.',
      schema: z.object({
        specialization: z.string().optional().describe('For example "cardiology", "skin", "children"'),
        name: z.string().optional().describe("Part of the doctor's name"),
      }),
    },
  );

  const getAvailableSlots = tool(
    async (input) => {
      const result = await attempt(() => backend.getAvailableSlots(input));
      if ('error' in result) return ok(result);
      return ok(
        result.value.length
          ? { date: input.date, slots: result.value.map((s) => ({ slotId: s.slotId, time: s.time })) }
          : { date: input.date, slots: [], note: 'No free slots on this date. Offer to check another date.' },
      );
    },
    {
      name: 'getAvailableSlots',
      description: 'Get the free appointment times for one doctor on one date. Never offer a time that is not in the result.',
      schema: z.object({ doctorId: id('The doctorId'), date }),
    },
  );

  const holdSlot = tool(
    async (input, config: RunnableConfig) => unwrap(await attempt(() => backend.holdSlot(input, contextOf(config)))),
    {
      name: 'holdSlot',
      description:
        'Reserve a slot for 10 minutes while you collect the patient’s details. Call this as soon as the patient picks a time.',
      schema: z.object({ slotId: id('The slotId') }),
    },
  );

  const confirmBooking = tool(
    async (input, config: RunnableConfig) =>
      unwrap(
        await attempt(() =>
          backend.confirmBooking({ ...input, phone: normalisePhone(input.phone) }, contextOf(config)),
        ),
      ),
    {
      name: 'confirmBooking',
      description:
        'Create the booking for a held slot. Only call this after you have read the doctor, date, time and fee back to the patient and they have said yes.',
      schema: z.object({
        slotId: id('The slotId that was held'),
        patientName: z.string().min(2).describe("The patient's full name, as they gave it"),
        phone,
        reason: z.string().optional().describe('Reason for the visit, if the patient mentioned one'),
      }),
    },
  );

  const getBookingStatus = tool(
    async (input) =>
      unwrap(await attempt(() => backend.getBookingStatus({ ...input, phone: normalisePhone(input.phone) }))),
    {
      name: 'getBookingStatus',
      description: 'Look up an existing booking. Needs the booking ID and the phone number it was booked with.',
      schema: z.object({ bookingId: id('The booking ID'), phone }),
    },
  );

  const cancelBooking = tool(
    async (input, config: RunnableConfig) => {
      const ctx = contextOf(config);
      const first = await attempt(() => backend.cancelBooking({ ...input, phone: normalisePhone(input.phone) }, ctx));
      return finishChange(first, 'CANCELLATION', () =>
        backend.cancelBooking({ ...input, phone: normalisePhone(input.phone), approved: true }, ctx),
      );
    },
    {
      name: 'cancelBooking',
      description:
        'Cancel a booking. Only call this after the patient has confirmed they want to cancel. Refunds and late cancellations are reviewed by clinic staff.',
      schema: z.object({ bookingId: id('The booking ID'), phone, reason: z.string().optional() }),
    },
  );

  const rescheduleBooking = tool(
    async (input, config: RunnableConfig) => {
      const ctx = contextOf(config);
      const first = await attempt(() =>
        backend.rescheduleBooking({ ...input, phone: normalisePhone(input.phone) }, ctx),
      );
      return finishChange(first, 'RESCHEDULE', () =>
        backend.rescheduleBooking({ ...input, phone: normalisePhone(input.phone), approved: true }, ctx),
      );
    },
    {
      name: 'rescheduleBooking',
      description:
        'Move a booking to another free slot with the same doctor. Only call this after the patient has confirmed the new date and time.',
      schema: z.object({ bookingId: id('The booking ID'), phone, newSlotId: id('The slotId of the new time') }),
    },
  );

  const createPaymentLink = tool(
    async (input, config: RunnableConfig) =>
      unwrap(
        await attempt(() =>
          backend.createPaymentLink({ ...input, phone: normalisePhone(input.phone) }, contextOf(config)),
        ),
      ),
    {
      name: 'createPaymentLink',
      description: 'Get the online payment link for a booking. Never state an amount that did not come from a tool.',
      schema: z.object({ bookingId: id('The booking ID'), phone }),
    },
  );

  const transferToHuman = tool(
    async (input, config: RunnableConfig) => unwrap(await attempt(() => backend.transferToHuman(input, contextOf(config)))),
    {
      name: 'transferToHuman',
      description:
        'Hand the conversation to clinic staff. Use when the patient asks for a person, is upset, describes a medical emergency, or asks for something you cannot do.',
      schema: z.object({ reason: z.string().describe('One sentence on why a human is needed') }),
    },
  );

  return {
    searchDoctors,
    getAvailableSlots,
    holdSlot,
    confirmBooking,
    getBookingStatus,
    cancelBooking,
    rescheduleBooking,
    createPaymentLink,
    transferToHuman,
  } satisfies Record<string, StructuredToolInterface>;
}

export type ClinicTools = ReturnType<typeof createClinicTools>;
