// Turns the date words a patient uses ("tomorrow", "Friday", "18 Nov") into
// exact dates, in code. The result is handed to the model as a hint, so it
// never has to do calendar arithmetic, which small models get wrong.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface DateHint {
  phrase: string;
  date: string; // YYYY-MM-DD
}

/** Today's date in the clinic timezone, as YYYY-MM-DD. */
export function localToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveDates(text: string, now: Date, timezone: string): DateHint[] {
  const today = localToday(now, timezone);
  const lower = text.toLowerCase();
  const hints: DateHint[] = [];
  const add = (phrase: string, date: string) => {
    if (!hints.some((h) => h.date === date)) hints.push({ phrase, date });
  };

  const iso = lower.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) add(iso[0], iso[0]);

  if (/\bday after tomorrow\b/.test(lower)) add('day after tomorrow', plusDays(today, 2));
  else if (/\b(tomorrow|tmrw|tomorow)\b/.test(lower)) add('tomorrow', plusDays(today, 1));
  if (/\b(today|tonight)\b/.test(lower)) add('today', today);

  // A weekday name means its next occurrence after today.
  const todayIndex = new Date(`${today}T00:00:00Z`).getUTCDay();
  for (const [index, name] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b${name}|\\b${name.slice(0, 3)}\\b`).test(lower)) {
      const ahead = (index - todayIndex + 7) % 7 || 7;
      add(name, plusDays(today, ahead));
    }
  }

  // "18 Nov", "18th of November", "Nov 18"
  const month = `(${MONTHS.join('|')})[a-z]*`;
  const dayFirst = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${month}`));
  const monthFirst = lower.match(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  const day = dayFirst ? Number(dayFirst[1]) : monthFirst ? Number(monthFirst[2]) : undefined;
  const monthName = dayFirst ? dayFirst[2] : monthFirst ? monthFirst[1] : undefined;
  if (day && monthName && day <= 31) {
    const year = Number(today.slice(0, 4));
    const build = (y: number) => `${y}-${String(MONTHS.indexOf(monthName) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // A date that has already passed this year means next year.
    add(`${day} ${monthName}`, build(year) >= today ? build(year) : build(year + 1));
  }

  return hints;
}
