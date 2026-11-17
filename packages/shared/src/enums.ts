import { z } from 'zod';

// These mirror the Prisma enums. They live here so the frontends and the agent
// package can use them without depending on the Prisma client.
export const Role = z.enum(['ADMIN', 'DOCTOR', 'PATIENT']);
export type Role = z.infer<typeof Role>;

export const SlotStatus = z.enum(['FREE', 'HELD', 'BOOKED', 'BLOCKED']);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const BookingStatus = z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED']);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const PaymentStatus = z.enum(['PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const Channel = z.enum(['CHAT', 'VOICE', 'PHONE']);
export type Channel = z.infer<typeof Channel>;
