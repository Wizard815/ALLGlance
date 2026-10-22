// Argument-shape rules for dayglance_update_task (container MCP).
// Ported verbatim (logic) from apps/dayglance/electron/mcpUpdateArgs.ts.

import { isValidLocalDate } from './dates.mjs';

const reject = (message) => ({ ok: false, code: 'validation', message });
const CLEARABLE = ['notes', 'deadline', 'assignee'];

export function planUpdateTask(args, multiUser = false) {
  const { task_id, title, notes, priority, deadline, assignee_id, clear_fields } = args;

  if (typeof task_id !== 'string' || !task_id.trim()) {
    return reject('task_id must be a non-empty string');
  }

  const clear = [];
  if (clear_fields !== undefined) {
    if (!Array.isArray(clear_fields)) {
      return reject(`clear_fields must be an array of field names, got ${JSON.stringify(clear_fields)}`);
    }
    for (const field of clear_fields) {
      if (field === 'title') {
        return reject('title is required on every task and cannot be cleared. To change it, pass a new title instead.');
      }
      if (typeof field !== 'string' || !CLEARABLE.includes(field)) {
        return reject(
          `${JSON.stringify(field)} is not a clearable field. clear_fields accepts only fields that can ` +
          'meaningfully be empty: notes, deadline, assignee.',
        );
      }
      if (field === 'assignee' && !multiUser) {
        return reject('assignee can be cleared only while multi-user mode is on in dayGLANCE Settings.');
      }
      if (!clear.includes(field)) clear.push(field);
    }
  }

  if (deadline !== undefined && clear.includes('deadline')) {
    return reject('deadline is both set and named in clear_fields. Set it or clear it, not both.');
  }
  if (notes !== undefined && clear.includes('notes')) {
    return reject('notes is both set and named in clear_fields. Set it or clear it, not both.');
  }
  if (assignee_id !== undefined && clear.includes('assignee')) {
    return reject('assignee_id is set while clear_fields names assignee. Set the assignee or clear it, not both.');
  }

  const set = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) return reject('title must be a non-empty string');
    set.title = title.trim();
  }
  if (notes !== undefined) {
    if (typeof notes !== 'string') return reject(`notes must be a string, got ${JSON.stringify(notes)}`);
    set.notes = notes;
  }
  if (priority !== undefined) {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3) {
      return reject(`priority must be an integer 0-3 (0 none, 1 low, 2 medium, 3 high), got ${JSON.stringify(priority)}`);
    }
    set.priority = priority;
  }
  if (deadline !== undefined) {
    if (!isValidLocalDate(deadline)) {
      return reject(`deadline must be a real local calendar date in strict YYYY-MM-DD form (no time), got ${JSON.stringify(deadline)}`);
    }
    set.deadline = deadline;
  }
  if (assignee_id !== undefined) {
    if (typeof assignee_id !== 'string' || !assignee_id.trim()) {
      return reject(`assignee_id must be a non-empty user id string, got ${JSON.stringify(assignee_id)}`);
    }
    set.assigneeSyncId = assignee_id;
  }

  if (Object.keys(set).length === 0 && clear.length === 0) {
    return reject(
      'Nothing to change: pass at least one field to set (title, notes, priority, deadline, assignee_id) ' +
      'or name one in clear_fields.',
    );
  }

  return { ok: true, plan: { taskId: task_id, set, clear } };
}
