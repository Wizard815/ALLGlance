// Argument-shape rules for dayglance_create_task (container MCP).
// Ported verbatim (logic) from apps/dayglance/electron/mcpCreateArgs.ts.

import { isValidLocalDate } from './dates.mjs';
import { validateStartTime, validateDurationMinutes } from './localTime.mjs';

const reject = (message) => ({ ok: false, code: 'validation', message });

export function planCreateTask(args, timeZone) {
  const { title, notes, project_id, assignee_id, priority, deadline, start, duration_minutes, all_day, repeat } = args;

  if (repeat !== undefined) {
    return reject(
      'Recurring tasks cannot be created over MCP in v1. Create the repeating series in dayGLANCE itself. ' +
      'To create a one-off task, drop the repeat argument.',
    );
  }
  if (typeof title !== 'string' || !title.trim()) {
    return reject('title must be a non-empty string');
  }

  const scheduled = start !== undefined;
  const allDay = all_day === true;

  if (scheduled && (priority !== undefined || deadline !== undefined)) {
    return reject(
      'Scheduled dayGLANCE tasks do not carry priority or deadline by design: those fields belong to inbox ' +
      'tasks only, and scheduling an inbox task drops them. Create the task without start to keep them.',
    );
  }
  if (project_id !== undefined && (priority !== undefined || deadline !== undefined)) {
    return reject(
      'dayGLANCE project tasks do not carry priority or deadline by design: the app manages project work ' +
      'through the project itself. Create the task without project_id to use priority or deadline.',
    );
  }

  let priorityValue;
  if (priority !== undefined) {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3) {
      return reject(`priority must be an integer 0-3 (0 none, 1 low, 2 medium, 3 high), got ${JSON.stringify(priority)}`);
    }
    priorityValue = priority;
  }
  if (deadline !== undefined && !isValidLocalDate(deadline)) {
    return reject(`deadline must be a real local calendar date in strict YYYY-MM-DD form (no time), got ${JSON.stringify(deadline)}`);
  }
  if (duration_minutes !== undefined) {
    const durationError = validateDurationMinutes(duration_minutes);
    if (durationError) return reject(durationError);
  }

  if (!scheduled && allDay) {
    return reject('all_day applies to scheduled creates only. Pass start (a bare YYYY-MM-DD date) alongside all_day.');
  }

  const plan = { title };
  if (typeof notes === 'string') plan.notes = notes;
  if (typeof project_id === 'string') plan.projectId = project_id;
  if (typeof assignee_id === 'string') plan.assigneeSyncId = assignee_id;

  if (!scheduled) {
    if (priorityValue !== undefined) plan.priority = priorityValue;
    if (deadline !== undefined) plan.deadline = deadline;
    if (typeof duration_minutes === 'number') plan.durationMinutes = duration_minutes;
    return { ok: true, plan };
  }

  if (allDay) {
    if (duration_minutes !== undefined) {
      return reject(
        'all_day and duration_minutes contradict each other: an all-day task has no meaningful duration. ' +
        'Drop duration_minutes, or drop all_day to create a timed block.',
      );
    }
    if (!isValidLocalDate(start)) {
      return reject(
        `with all_day, start is a bare local calendar date: all-day tasks take a date only, no time component. ` +
        `Expected strict YYYY-MM-DD, got ${JSON.stringify(start)}`,
      );
    }
    plan.schedule = { date: start, startTime: '00:00', durationMinutes: 30, allDay: true };
    return { ok: true, plan };
  }

  if (typeof start !== 'string' || !/^\S+ \S+$/.test(start)) {
    return reject(`start must be "YYYY-MM-DD HH:MM" (local calendar date + local wall-clock time), got ${JSON.stringify(start)}`);
  }
  const [date, time] = start.split(' ');
  if (!isValidLocalDate(date)) {
    return reject(`start date must be a real local calendar date in strict YYYY-MM-DD form, got ${JSON.stringify(date)}`);
  }
  const timeError = validateStartTime(date, time, timeZone);
  if (timeError) return reject(timeError);

  plan.schedule = {
    date,
    startTime: time,
    durationMinutes: typeof duration_minutes === 'number' ? duration_minutes : 30,
    allDay: false,
  };
  return { ok: true, plan };
}
