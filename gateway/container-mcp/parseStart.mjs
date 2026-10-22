// Parse a local "YYYY-MM-DD HH:MM" start string used by schedule_task and
// move_block. Returns { date, time } or { invalid }. Verbatim behavior of the
// Electron layer's parseStart (mcpCreateArgs + mcpLocalTime rules).

import { isValidLocalDate } from './dates.mjs';
import { validateStartTime } from './localTime.mjs';

export function parseStart(start, timeZone) {
  if (typeof start !== 'string' || !/^\S+ \S+$/.test(start)) {
    return { invalid: `start must be "YYYY-MM-DD HH:MM" (local calendar date + local wall-clock time), got ${JSON.stringify(start)}` };
  }
  const [date, time] = start.split(' ');
  if (!isValidLocalDate(date)) {
    return { invalid: `start date must be a real local calendar date in strict YYYY-MM-DD form, got ${JSON.stringify(date)}` };
  }
  const timeError = validateStartTime(date, time, timeZone);
  if (timeError) return { invalid: timeError };
  return { date, time };
}
