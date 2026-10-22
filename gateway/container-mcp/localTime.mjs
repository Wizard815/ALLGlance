// Local wall-clock time semantics for the containerized dayGLANCE MCP writes.
// Ported verbatim (logic) from apps/dayglance/electron/mcpLocalTime.ts.

export function isValidWallTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function wallClockAt(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { h: Number(get('hour')), m: Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

export function resolveLocalTime(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);

  const offsets = new Set();
  for (const probe of [asUtc - 24 * 3600_000, asUtc, asUtc + 24 * 3600_000]) {
    const wc = wallClockAt(probe, timeZone);
    const wcUtc = Date.UTC(
      Number(wc.date.slice(0, 4)), Number(wc.date.slice(5, 7)) - 1, Number(wc.date.slice(8, 10)),
      wc.h, wc.m,
    );
    offsets.add(wcUtc - probe);
  }

  let occurrences = 0;
  for (const offset of offsets) {
    const candidate = asUtc - offset;
    const wc = wallClockAt(candidate, timeZone);
    if (wc.date === date && wc.h === h && wc.m === mi) occurrences++;
  }

  if (occurrences === 0) return { kind: 'nonexistent' };
  if (occurrences === 1) return { kind: 'unique' };
  return { kind: 'ambiguous' };
}

export function validateStartTime(date, time, timeZone) {
  if (!isValidWallTime(time)) {
    return `start time must be local wall-clock HH:MM (24h, zero-padded), got ${JSON.stringify(time)}`;
  }
  const res = resolveLocalTime(date, time, timeZone);
  if (res.kind === 'nonexistent') {
    return `${time} does not exist on ${date} in ${timeZone} (DST skips it); pick a time outside the transition gap`;
  }
  if (res.kind === 'ambiguous') {
    return `${time} occurs twice on ${date} in ${timeZone} (DST repeats it); pick an unambiguous time`;
  }
  return null;
}

export function validateDurationMinutes(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `duration_minutes must be an integer, got ${JSON.stringify(value)}`;
  }
  if (value < 1 || value > 1440) {
    return `duration_minutes must be between 1 and 1440, got ${value}`;
  }
  return null;
}
