// When a task was created and completed, for display (#2135).
//
// `createdAt` is stamped by the persist pass (utils/createdAt.js has the rules);
// `completedAt` by every completion path. This module only reads them.

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A stored stamp as a Date plus whether it carries a time. `completedAt` has
 * been written three ways over the years: local-offset ISO (completionTimestamp),
 * UTC ISO (intents, the launcher) and, in old data, a bare YYYY-MM-DD. A bare
 * date is read as that LOCAL calendar day: `new Date('2026-10-19')` would be
 * UTC midnight, which is the day before anywhere west of Greenwich.
 */
export function parseStamp(value) {
  if (typeof value !== 'string' || !value) return null;
  if (BARE_DATE.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return { date: new Date(y, m - 1, d, 12), hasTime: false };
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return { date: new Date(ms), hasTime: true };
}

/**
 * When a task (or one occurrence of a recurring one) was created and
 * completed, as stored stamps, or null where not known.
 *
 * A recurring occurrence has no row of its own: the series was created once
 * (the template's `createdAt`), and each date's completion is kept on the
 * template (`completedDatesTimestamps`, the same local-offset stamp).
 *
 * @param {object} task  the task as shown (a concrete task, or an expanded occurrence)
 * @param {object} [opts]
 * @param {object[]} [opts.recurringTasks]  templates, to resolve an occurrence
 */
export function taskMoments(task, { recurringTasks = [] } = {}) {
  if (!task) return { createdAt: null, completedAt: null };
  if (task.isRecurring && task.recurringTemplateId != null) {
    const template = recurringTasks.find((r) => String(r.id) === String(task.recurringTemplateId));
    const date = task.date;
    const done = !!task.completed;
    return {
      createdAt: template?.createdAt || null,
      completedAt: done ? (template?.completedDatesTimestamps?.[date] || null) : null,
    };
  }
  return {
    createdAt: task.createdAt || null,
    completedAt: task.completed ? (task.completedAt || null) : null,
  };
}

/**
 * A stamp for display: "Oct 19, 2:05 PM", with the year when it is not this
 * year, and the date alone when the stamp has no time.
 *
 * @param {string} value  a stored stamp
 * @param {object} opts
 * @param {(hhmm: string) => string} opts.formatTime  the app's clock formatter
 * @param {Date} [opts.now]
 * @param {string} [opts.language]
 */
export function formatStamp(value, { formatTime = (s) => s, now = new Date(), language } = {}) {
  const parsed = parseStamp(value);
  if (!parsed) return null;
  const { date, hasTime } = parsed;
  const options = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  const day = new Intl.DateTimeFormat(language, options).format(date);
  if (!hasTime) return day;
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${day}, ${formatTime(hhmm)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A stamp in the MCP wire convention (docs/mcp-tools-reference.md: dates and
 * times are local, no offsets, no timestamps): `{ date: 'YYYY-MM-DD', time:
 * 'HH:MM' | null }` on this machine's clock, `time` null for a stamp that has
 * none. Null when there is no stamp to read.
 */
export function wireStamp(value) {
  const parsed = parseStamp(value);
  if (!parsed) return null;
  const { date, hasTime } = parsed;
  return {
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: hasTime ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : null,
  };
}
