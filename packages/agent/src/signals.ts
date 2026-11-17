import { PhoneSchema } from '@clinic/shared';
import { resolveDates } from './dates';

// Things the patient has already said, picked out in code. They feed three
// places: hints in the prompt, the checks on the model's tool calls, and the
// fast path that makes a tool call without asking the model at all.

export interface Turn {
  role: 'patient' | 'assistant';
  text: string;
}

export interface Signals {
  /** Times the patient mentioned recently, as HH:mm. "3:30" yields both 03:30 and 15:30. */
  times: string[];
  /** Dates the patient named in their last few messages (YYYY-MM-DD), newest first. */
  dates: string[];
  /** The last valid mobile number the patient typed. */
  phone?: string;
  /** The patient's name, if they stated it or answered a question asking for it. */
  name?: string;
  /** A booking reference the patient typed, normalised to BK-XXXXXX. */
  bookingReference?: string;
  /** The patient's latest message is a plain yes. */
  saidYes: boolean;
  /** The assistant's last message asked for a confirmation. */
  askedToConfirm: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function parseTimes(text: string): string[] {
  const times = new Set<string>();
  const pattern = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\W|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const [, h, m, meridiem] = match;
    // A bare number ("2", "18") is not a time unless it has minutes or am/pm.
    if (!m && !meridiem) continue;
    const hour = Number(h);
    const minute = Number(m ?? 0);
    if (hour > 23 || minute > 59) continue;

    if (meridiem) {
      const pm = meridiem.toLowerCase().startsWith('p');
      if (hour < 1 || hour > 12) continue;
      times.add(`${pad((hour % 12) + (pm ? 12 : 0))}:${pad(minute)}`);
    } else {
      times.add(`${pad(hour)}:${pad(minute)}`);
      if (hour >= 1 && hour < 12) times.add(`${pad(hour + 12)}:${pad(minute)}`); // "3:30" may mean 15:30
    }
  }
  return [...times];
}

const PHONE = /(?:\+?91[\s-]?)?[6-9]\d(?:[\s-]?\d){8}/g;

export function parsePhone(text: string): string | undefined {
  return (text.match(PHONE) ?? []).reverse().find((c) => PhoneSchema.safeParse(c).success);
}

export function parseBookingReference(text: string): string | undefined {
  const match = text.toUpperCase().match(/\bBK[\s-]?([A-Z0-9]{6})\b/g)?.pop();
  return match ? `BK-${match.replace(/[^A-Z0-9]/g, '').slice(2)}` : undefined;
}

const YES = /^\s*(yes|yeah|yep|yup|ya|ok|okay|sure|correct|right|confirm|confirmed|please do|go ahead|do it|haan|ha)\b/i;
const NO = /\b(no|not|don'?t|wait|change|different|another)\b/i;
const NAME_SHAPE = /^[A-Za-z][A-Za-z .'-]{1,40}$/;
const STATED_NAME = /\b(?:my name is|name is|i am|i'm|this is|myself)\s+([A-Za-z][A-Za-z .'-]{1,40})/i;
const NOT_A_NAME = /\b(yes|no|ok|okay|sure|please|thanks|thank|tomorrow|today|book|appointment|doctor|cancel|confirm|hi|hello|am|pm)\b/i;

function cleanName(raw: string): string | undefined {
  const name = raw
    .replace(PHONE, ' ')
    .replace(/\band\b.*$/i, '') // "Asha Verma and my number is ..."
    .replace(/[,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  if (!NAME_SHAPE.test(name) || name.split(' ').length > 4 || NOT_A_NAME.test(name)) return undefined;
  return name;
}

/** The patient's name: either stated outright, or the answer to "what is your name?". */
export function parseName(turns: Turn[]): string | undefined {
  let name: string | undefined;
  turns.forEach((turn, i) => {
    if (turn.role !== 'patient') return;
    const stated = turn.text.match(STATED_NAME)?.[1];
    const askedForName = i > 0 && turns[i - 1].role === 'assistant' && /\bname\b/i.test(turns[i - 1].text);
    // "Asha Verma" on its own: two to four capitalised words and nothing else.
    const bare = /^\s*([A-Z][a-z'-]+\.?\s+){1,3}[A-Z][a-z'-]+\s*$/.test(turn.text.replace(PHONE, ' '));
    const found = (stated && cleanName(stated)) || (askedForName || bare ? cleanName(turn.text) : undefined);
    if (found) name = found;
  });
  return name;
}

export function readSignals(turns: Turn[], now: Date = new Date(), timezone = 'UTC'): Signals {
  const patient = turns.filter((t) => t.role === 'patient').map((t) => t.text);
  const latest = patient[patient.length - 1] ?? '';
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')?.text ?? '';
  const everything = patient.join(' ; ');
  const dates = patient
    .slice(-3)
    .reverse()
    .flatMap((text) => resolveDates(text, now, timezone).map((h) => h.date));
  return {
    dates: [...new Set(dates)],
    // The last two messages: the patient may name a time one turn before the slots are fetched.
    times: parseTimes(patient.slice(-2).join(' ; ').replace(PHONE, ' ')),
    phone: parsePhone(everything),
    name: parseName(turns),
    bookingReference: parseBookingReference(everything),
    saidYes: YES.test(latest) && !NO.test(latest),
    askedToConfirm: /\b(shall i|should i|do you want me to|are you sure|confirm)\b[^?]*\?/i.test(lastAssistant),
  };
}
