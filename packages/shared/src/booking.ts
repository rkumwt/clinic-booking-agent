import { z } from 'zod';
import { Channel } from './enums';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// Indian mobile numbers, stored as +91XXXXXXXXXX.
export const PhoneSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (v.startsWith('+91') ? v : `+91${v.replace(/^0/, '')}`))
  .refine((v) => /^\+91[6-9]\d{9}$/.test(v), { message: 'Expected a 10-digit Indian mobile number' });

export const GetSlotsSchema = z.object({
  doctorId: z.string().min(1),
  date: dateOnly, // a day in the clinic's timezone
});
export type GetSlotsInput = z.infer<typeof GetSlotsSchema>;

export const HoldSlotSchema = z.object({
  slotId: z.string().min(1),
  // Identifies who owns the hold (chat session id). Re-holding with the same
  // key is a no-op, which makes the call idempotent.
  holderKey: z.string().min(8),
});
export type HoldSlotInput = z.infer<typeof HoldSlotSchema>;

export const ConfirmBookingSchema = z.object({
  slotId: z.string().min(1),
  holderKey: z.string().min(8),
  patient: z.object({
    name: z.string().min(2),
    phone: PhoneSchema,
    email: z.string().email().optional(),
  }),
  channel: Channel.default('CHAT'),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8),
});
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingSchema>;

// `phone` is how a patient proves a booking is theirs. Staff do not need it.
export const CancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
  phone: z.string().optional(),
});
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

export const RescheduleBookingSchema = z.object({
  newSlotId: z.string().min(1),
  holderKey: z.string().min(8),
  phone: z.string().optional(),
});
export type RescheduleBookingInput = z.infer<typeof RescheduleBookingSchema>;
