import { PhoneSchema } from '@clinic/shared';
import { maskEmail, maskPhone, maskPii } from './mask';
import { addDays, dayBoundsUtc, localDateString, weekdayOf } from './time';

describe('masking', () => {
  it('masks phone numbers and emails', () => {
    expect(maskPhone('+919876543210')).toBe('*********3210');
    expect(maskEmail('rajesh@example.com')).toBe('r***@example.com');
  });

  it('masks contact details inside free text', () => {
    const masked = maskPii('Call me on 98765 43210 or mail rajesh@example.com please');
    expect(masked).not.toContain('98765');
    expect(masked).not.toContain('rajesh@');
    expect(masked).toContain('3210');
  });
});

describe('time helpers', () => {
  it('finds the local date for an instant', () => {
    // 20:00 UTC is already the next day in India.
    expect(localDateString(new Date('2026-11-16T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-17');
  });

  it('adds days across a month boundary and finds weekdays', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
    expect(weekdayOf('2026-11-16')).toBe(1);
  });

  it('bounds a local day in UTC', () => {
    const { start, end } = dayBoundsUtc('2026-11-16', 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-11-15T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-16T18:30:00.000Z');
  });
});

describe('PhoneSchema', () => {
  it('normalises common formats to +91XXXXXXXXXX', () => {
    for (const input of ['9876543210', '09876543210', '+91 98765 43210', '98765-43210']) {
      expect(PhoneSchema.parse(input)).toBe('+919876543210');
    }
  });

  it('rejects numbers that are not Indian mobiles', () => {
    for (const input of ['12345', '1234567890', '+1 415 555 0100', 'abc']) {
      expect(PhoneSchema.safeParse(input).success).toBe(false);
    }
  });
});
