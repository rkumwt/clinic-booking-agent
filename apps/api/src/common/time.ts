import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

// All timestamps are stored in UTC. "Date strings" (YYYY-MM-DD) and "times"
// (HH:mm) are always in the clinic's timezone.

export function localDateString(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, 'yyyy-MM-dd');
}

export function zonedToUtc(date: string, time: string, timezone: string): Date {
  return fromZonedTime(`${date}T${time}:00`, timezone);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** UTC instants that bound one local calendar day: [start, end). */
export function dayBoundsUtc(date: string, timezone: string): { start: Date; end: Date } {
  return {
    start: zonedToUtc(date, '00:00', timezone),
    end: zonedToUtc(addDays(date, 1), '00:00', timezone),
  };
}

/** A @db.Date column comes back as midnight UTC; this recovers the date string. */
export function dbDateToString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
