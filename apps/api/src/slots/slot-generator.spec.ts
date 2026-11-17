import { generateSlots } from './slot-generator';

const base = { leaves: [], slotMinutes: 30, timezone: 'Asia/Kolkata' };
// 2026-11-16 is a Monday.
const MONDAY = '2026-11-16';

describe('generateSlots', () => {
  it('cuts a shift into fixed-length slots in the clinic timezone', () => {
    const slots = generateSlots({
      ...base,
      workingHours: [{ weekday: 1, startTime: '09:00', endTime: '11:00' }],
      fromDate: MONDAY,
      days: 1,
    });
    expect(slots).toHaveLength(4);
    // 09:00 IST is 03:30 UTC.
    expect(slots[0].startTime.toISOString()).toBe('2026-11-16T03:30:00.000Z');
    expect(slots[0].endTime.toISOString()).toBe('2026-11-16T04:00:00.000Z');
    expect(slots[3].endTime.toISOString()).toBe('2026-11-16T05:30:00.000Z');
  });

  it('only generates on the weekdays the doctor works', () => {
    const slots = generateSlots({
      ...base,
      workingHours: [{ weekday: 1, startTime: '09:00', endTime: '10:00' }],
      fromDate: MONDAY,
      days: 14,
    });
    expect(slots).toHaveLength(4); // two Mondays, two slots each
  });

  it('supports split shifts on the same day', () => {
    const slots = generateSlots({
      ...base,
      workingHours: [
        { weekday: 1, startTime: '17:00', endTime: '18:00' },
        { weekday: 1, startTime: '09:00', endTime: '10:00' },
      ],
      fromDate: MONDAY,
      days: 1,
    });
    expect(slots).toHaveLength(4);
    const starts = slots.map((s) => s.startTime.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('skips leave days, inclusive of both ends', () => {
    const slots = generateSlots({
      ...base,
      workingHours: [1, 2, 3, 4].map((weekday) => ({ weekday, startTime: '09:00', endTime: '10:00' })),
      leaves: [{ startDate: '2026-11-17', endDate: '2026-11-18' }],
      fromDate: MONDAY,
      days: 4,
    });
    const days = [...new Set(slots.map((s) => s.startTime.toISOString().slice(0, 10)))];
    expect(days).toEqual(['2026-11-16', '2026-11-19']);
  });

  it('drops a trailing partial slot', () => {
    const slots = generateSlots({
      ...base,
      slotMinutes: 20,
      workingHours: [{ weekday: 1, startTime: '09:00', endTime: '09:50' }],
      fromDate: MONDAY,
      days: 1,
    });
    expect(slots).toHaveLength(2);
  });

  it('handles a timezone with daylight saving', () => {
    // US clocks go back on 2026-11-01, so 09:00 local moves from 13:00 to 14:00 UTC.
    const slots = generateSlots({
      leaves: [],
      slotMinutes: 60,
      timezone: 'America/New_York',
      workingHours: [0, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '10:00' })),
      fromDate: '2026-10-31',
      days: 2,
    });
    expect(slots.map((s) => s.startTime.toISOString())).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
    ]);
  });
});
