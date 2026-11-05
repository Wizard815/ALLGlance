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
 * @property {number}  priority            0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 do now (vikunja's scale;
 *                                          dayGLANCE's 0-3 means the same for 0-3).
 * @property {string}  priority_label      'none' | 'low' | 'medium' | 'high' | 'urgent' | 'do now'
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

/** Priority on vikunja's scale. CalDAV (RFC 5545 PRIORITY, 1 highest, 9 lowest)
 *  maps onto it the way vikunja's own CalDAV server does (pkg/caldav/priority.go). */
export const PRIORITY_LABELS = ['none', 'low', 'medium', 'high', 'urgent', 'do now'];
export function toPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}
export const priorityFromCaldav = (p) => [0, 5, 4, 3, 3, 2, 1, 1, 1, 1][toCaldavRange(p)] ?? 0;
export const priorityToCaldav = (p) => [0, 9, 5, 3, 2, 1][toPriority(p)];
const toCaldavRange = (p) => Math.max(0, Math.min(9, Math.round(Number(p) || 0)));

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
    duration_minutes: typeof raw.duration === 'number' ? raw.duration : (typeof raw.duration_minutes === 'number' ? raw.duration_minutes : null),
    priority: toPriority(raw.priority),
    priority_label: PRIORITY_LABELS[toPriority(raw.priority)],
    extra: { ...raw },
  };
}

export default { SOURCES, PRIORITY_LABELS, taskOf, toDate, toClock, toPriority, priorityFromCaldav, priorityToCaldav };
