// Local-calendar-date semantics for the containerized dayGLANCE MCP.
// Ported verbatim (logic) from apps/dayglance/electron/mcpDates.ts, which is
// pure and testable without Electron.

/** Strict local-calendar-date validation: YYYY-MM-DD, a date that exists. */
export function isValidLocalDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth;
}

/** The local calendar date of `epochMs` in `timeZone`, as YYYY-MM-DD. */
export function localDateOf(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochMs));
}

/** The {date, timezone} echo every dated tool response carries. */
export function dateEnvelope(date, timeZone) {
  return { date, timezone: timeZone };
}
