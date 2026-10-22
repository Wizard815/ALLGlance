// Canonical data model shared by every data-plane adapter.
//
// Every adapter (vikunja, dayGLANCE, lastGLANCE, lifeGLANCE) returns records
// in these shapes so the unification layer and the MCP/REST front ends never
// care which app a record came from. See DESIGN.md §4 for the per-app field
// mapping.

/**
 * @typedef {Object} Identity
 * @property {string} id   Normalized owner id (roster key).
 * @property {string} name Human-readable name.
 *
 * @typedef {Object} Task
 * @property {string}  source            One of: 'vikunja','dayglance','lastglance','lifeglance'.
 * @property {string}  id                Unique within its source.
 * @property {string}  title
 * @property {string|null} owner_id       Null when the source has no ownership model (lifeGLANCE).
 * @property {string|null} due_date        ISO date 'YYYY-MM-DD' or null.
 * @property {boolean} completed
 * @property {string|null} project_id
 * @property {boolean} all_day
 * @property {string|null} start_time     'HH:MM' local wall-clock or null.
 * @property {number|null} duration_minutes
 * @property {Object}  [extra]             Source-specific fields preserved for fidelity.
 *
 * @typedef {Object} Milestone
 * @property {string}  source
 * @property {string}  id
 * @property {string}  title
 * @property {string}  date               ISO date 'YYYY-MM-DD'.
 * @property {string|null} owner_id
 * @property {Object}  [extra]
 */

export const SOURCES = ['vikunja', 'dayglance', 'lastglance', 'lifeglance'];

/** Normalize an ISO timestamp or date string to a 'YYYY-MM-DD' date. */
export function toDate(iso) {
  if (!iso) return null;
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso)) {
    return iso.slice(0, 10);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Normalize an 'HH:MM' or 'HH:MM:SS' time to 'HH:MM'. */
export function toClock(time) {
  if (!time) return null;
  if (typeof time === 'string' && /^\d{2}:\d{2}/.test(time)) return time.slice(0, 5);
  return null;
}

/**
 * Coerce an arbitrary adapter row into the canonical Task shape.
 * @param {string} source
 * @param {Record<string, unknown>} raw
 * @param {string|null} owner
 * @param {string} [fallbackTitle]
 */
export function taskOf(source, raw, owner, fallbackTitle) {
  const due = toDate(raw.due_date ?? raw.due ?? raw.dueDate ?? raw.completedAt ?? raw.startedAt);
  const title = String(raw.title ?? raw.name ?? raw.summary ?? fallbackTitle ?? '(untitled)').trim();
  const completed = Boolean(raw.completed ?? raw.done ?? raw.status === 'closed' ?? raw.finished ?? false);
  return {
    source,
    id: String(raw.id ?? raw.uuid ?? raw.key ?? raw.taskId ?? null),
    title,
    owner_id: owner ?? null,
    due_date: due,
    completed,
    project_id: raw.project_id ?? raw.project ?? null,
    all_day: Boolean(raw.all_day ?? raw.isAllDay ?? false),
    start_time: toClock(raw.start_time ?? raw.startTime),
    duration_minutes: typeof raw.duration === 'number' ? raw.duration : null,
    extra: { ...raw },
  };
}

export default { SOURCES, taskOf, toDate, toClock };
