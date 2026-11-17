import { z } from 'zod';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const WorkingHoursSchema = z
  .object({
    weekday: z.number().int().min(0).max(6), // 0 = Sunday
    startTime: timeOfDay,
    endTime: timeOfDay,
  })
  .refine((h) => h.startTime < h.endTime, { message: 'startTime must be before endTime' });
export type WorkingHoursInput = z.infer<typeof WorkingHoursSchema>;

export const CreateDoctorSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  specialization: z.string().min(2),
  feeInr: z.number().int().positive(),
  slotMinutes: z.number().int().min(10).max(120).default(30),
  bio: z.string().optional(),
  workingHours: z.array(WorkingHoursSchema).default([]),
});
export type CreateDoctorInput = z.infer<typeof CreateDoctorSchema>;

export const UpdateDoctorSchema = z.object({
  name: z.string().min(2).optional(),
  specialization: z.string().min(2).optional(),
  feeInr: z.number().int().positive().optional(),
  slotMinutes: z.number().int().min(10).max(120).optional(),
  bio: z.string().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDoctorInput = z.infer<typeof UpdateDoctorSchema>;

export const SetWorkingHoursSchema = z.object({ workingHours: z.array(WorkingHoursSchema) });
export type SetWorkingHoursInput = z.infer<typeof SetWorkingHoursSchema>;

export const CreateLeaveSchema = z
  .object({
    startDate: dateOnly,
    endDate: dateOnly,
    reason: z.string().optional(),
  })
  .refine((l) => l.startDate <= l.endDate, { message: 'startDate must not be after endDate' });
export type CreateLeaveInput = z.infer<typeof CreateLeaveSchema>;

export const SearchDoctorsSchema = z.object({
  specialization: z.string().optional(),
  name: z.string().optional(),
});
export type SearchDoctorsInput = z.infer<typeof SearchDoctorsSchema>;
