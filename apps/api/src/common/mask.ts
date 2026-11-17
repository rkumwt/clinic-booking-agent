// Used wherever patient contact details could end up in a log line.

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

const PHONE_RE = /(\+?\d[\d\s-]{7,}\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Masks phone numbers and emails inside free text, e.g. a chat transcript line. */
export function maskPii(text: string): string {
  return text.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PHONE_RE, (m) => maskPhone(m.replace(/[\s-]/g, '')));
}
