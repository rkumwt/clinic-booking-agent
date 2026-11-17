import { addDays, weekdayOf, zonedToUtc } from '../common/time';

export interface Shift {
  weekday: number; // 0 = Sunday
  startTime: string; // HH:mm, clinic timezone
  endTime: string;
}

export interface LeaveRange {
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string;
}

export interface GenerateSlotsInput {
  workingHours: Shift[];
  leaves: LeaveRange[];
  slotMinutes: number;
  fromDate: string; // first local day to generate
  days: number;
  timezone: string;
}

export interface SlotWindow {
  startTime: Date;
  endTime: Date;
}

/**
 * Pure function: working hours minus leaves, cut into fixed-length slots.
 * A trailing partial slot (e.g. the last 10 minutes of a shift) is dropped.
 */
export function generateSlots(input: GenerateSlotsInput): SlotWindow[] {
  const slots: SlotWindow[] = [];
  const stepMs = input.slotMinutes * 60_000;

  for (let i = 0; i < input.days; i++) {
    const date = addDays(input.fromDate, i);
    // ISO date strings compare correctly as plain strings.
    if (input.leaves.some((l) => l.startDate <= date && date <= l.endDate)) continue;

    for (const shift of input.workingHours.filter((s) => s.weekday === weekdayOf(date))) {
      const shiftEnd = zonedToUtc(date, shift.endTime, input.timezone).getTime();
      let start = zonedToUtc(date, shift.startTime, input.timezone).getTime();
      while (start + stepMs <= shiftEnd) {
        slots.push({ startTime: new Date(start), endTime: new Date(start + stepMs) });
        start += stepMs;
      }
    }
  }
  return slots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
