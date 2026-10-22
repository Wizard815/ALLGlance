// Saving the task editor over one occurrence of a recurring series (#2042).
//
// The editor shows an occurrence: the template with that date's exception laid
// over it. Title, time, duration, all-day, colour and assignment can belong to
// either the occurrence or the series, so when one of them changes the user
// picks the scope: 'this' writes it to the date's exception, 'all' writes it to
// the template and clears the same field from every exception so the series
// value shows on every occurrence. Fields the edit did not change are left
// alone either way: a series colour change keeps a moved occurrence's time.
//
// Project and the recurrence pattern are series-level and always go to the
// template, whichever scope is picked.

import { recurringTaskInstance } from './expandRecurringTasks.js';
import { editedSeriesStart } from './recurrenceEngine.js';

export const INSTANCE_FIELDS = ['title', 'startTime', 'duration', 'isAllDay', 'color'];

const sameAssignment = (a, b) => {
  const norm = (ids) => [...(ids || [])].map(String).sort().join('\u0000');
  return norm(a) === norm(b);
};

/**
 * What an edit changes on one occurrence, against the occurrence as stored.
 *
 * @param template  The recurring template.
 * @param dateStr   The occurrence's date.
 * @param edit      { title, startTime, duration, isAllDay, color,
 *                    assignedUserSyncIds }, already normalized by the caller.
 * @param opts.defaultColor  The colour the editor shows for a series with none
 *                    stored, so opening and saving is not read as a change.
 * @returns { fields, assignmentChanged, any } — `fields` holds only the
 *          instance fields whose value differs.
 */
export function instanceEditChanges(template, dateStr, edit, { defaultColor } = {}) {
  const current = recurringTaskInstance(template, dateStr);
  if (current.color == null && defaultColor) current.color = defaultColor;
  const fields = {};
  for (const key of INSTANCE_FIELDS) {
    // An all-day occurrence has no start time to change.
    if (key === 'startTime' && edit.isAllDay && current.isAllDay) continue;
    if (edit[key] !== undefined && edit[key] !== current[key]) fields[key] = edit[key];
  }
  const assignmentChanged = edit.assignedUserSyncIds !== undefined
    && !sameAssignment(edit.assignedUserSyncIds, current.assignedUserSyncIds);
  return { fields, assignmentChanged, any: assignmentChanged || Object.keys(fields).length > 0 };
}

/**
 * The template after the edit.
 *
 * @param opts.dateStr     The edited occurrence's date.
 * @param opts.edit        As for instanceEditChanges.
 * @param opts.scope       'this' or 'all'.
 * @param opts.projectId   Series-level.
 * @param opts.recurrence  Series-level; the start never moves earlier (see
 *                         editedSeriesStart for yearly and biweekly).
 * @param opts.now         ISO stamp for lastModified.
 * @param opts.defaultColor As for instanceEditChanges.
 */
export function applyRecurringInstanceEdit(template, { dateStr, edit, scope, projectId, recurrence, now, defaultColor }) {
  const { fields, assignmentChanged } = instanceEditChanges(template, dateStr, edit, { defaultColor });
  const next = { ...template };
  let exceptions = { ...(template.exceptions || {}) };

  if (scope === 'all') {
    Object.assign(next, fields);
    const cleared = Object.keys(fields);
    if (assignmentChanged) {
      next.assignedUserSyncIds = edit.assignedUserSyncIds;
      cleared.push('assignedUserSyncIds');
    }
    if (cleared.length) {
      // An exception's key stays even when it ends up empty: its presence
      // marks a saved occurrence for the statistics history.
      exceptions = Object.fromEntries(Object.entries(exceptions).map(([d, exc]) => {
        if (!exc || !cleared.some(k => k in exc)) return [d, exc];
        const rest = { ...exc };
        for (const k of cleared) delete rest[k];
        return [d, rest];
      }));
    }
  } else {
    const own = { ...fields };
    // An empty array means "everybody" for this date; it is still an override.
    if (assignmentChanged) own.assignedUserSyncIds = edit.assignedUserSyncIds;
    if (Object.keys(own).length) exceptions[dateStr] = { ...(exceptions[dateStr] || {}), ...own };
  }

  next.exceptions = exceptions;
  next.projectId = projectId || undefined;
  if (recurrence) {
    // The start never moves earlier, which would invent occurrences before
    // the series existed; yearly and biweekly may move it forward to stay
    // anchored on this occurrence (editedSeriesStart).
    next.recurrence = { ...recurrence, startDate: editedSeriesStart(recurrence, template.recurrence?.startDate, dateStr) };
  }
  next.lastModified = now;
  return next;
}
