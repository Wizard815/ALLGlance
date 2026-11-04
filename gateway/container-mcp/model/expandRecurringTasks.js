// Recurring templates → virtual per-date instances, over an inclusive date
// range. Lifted verbatim out of the `expandedRecurringTasks` memo in App.jsx
// so the widget month window (widgetMonthWindow.js) can be tested through the
// same expansion the app renders with, not a stand-in for it. The range comes
// from computeRecurringExpansionRange (recurringExpansionRange.js).

import { getOccurrencesInRange } from './recurrenceEngine.js';

// The same occurrence shape is also used by read-only historical statistics.
// Keeping this separate does not change which dates the live app expands.
export function recurringTaskInstance(template, date) {
  const completed = (template.completedDates || []).includes(date);
  const exception = template.exceptions?.[date];
  return {
    id: `recurring-${template.id}-${date}`,
    title: exception?.title ?? template.title,
    startTime: exception?.startTime ?? template.startTime,
    duration: exception?.duration ?? template.duration,
    color: exception?.color ?? template.color,
    completed,
    isAllDay: exception?.isAllDay ?? template.isAllDay ?? false,
    // Assignment is series-level by default (inherited from the template),
    // but an instance can carry its own override when assigned "this only".
    assignedUserSyncIds: exception?.assignedUserSyncIds ?? template.assignedUserSyncIds,
    notes: template.notes || '',
    subtasks: template.subtasks || [],
    // Energy-axis override is series-level (see setTaskEnergy); the
    // expansion is an explicit field list, so it must be carried here or
    // instances silently fall back to auto-derivation.
    energy: template.energy,
    date,
    isRecurring: true,
    recurringTemplateId: template.id,
    recurrenceType: template.recurrence?.type,
    // Project membership is series-level (stored on the template);
    // instances inherit it so project-filtered views keep occurrences.
    projectId: template.projectId,
    ...(template.isExample ? { isExample: true } : {}),
  };
}

/**
 * @param recurringTasks  Templates.
 * @param opts.rangeStart 'YYYY-MM-DD', inclusive.
 * @param opts.rangeEnd   'YYYY-MM-DD', inclusive.
 * @param opts.today      'YYYY-MM-DD' — past uncompleted timed instances are
 *                        dropped (all-day ones surface as overdue instead).
 * @returns Instance task objects, keyed `recurring-<templateId>-<date>`.
 */
export function expandRecurringTasks(recurringTasks, { rangeStart, rangeEnd, today }) {
  const instances = [];
  for (const template of recurringTasks) {
    const occurrences = getOccurrencesInRange(template, rangeStart, rangeEnd);
    for (const dateStr of occurrences) {
      const completed = (template.completedDates || []).includes(dateStr);
      const exception = template.exceptions?.[dateStr];
      // Don't show past uncompleted recurring instances (except all-day — those surface as overdue)
      if (dateStr < today && !completed && !(exception?.isAllDay ?? template.isAllDay)) continue;
      instances.push(recurringTaskInstance(template, dateStr));
    }
  }
  return instances;
}
