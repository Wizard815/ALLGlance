// The MCP tool surface of the AllGLANCE gateway: a deliberately small set that
// covers all four apps, with descriptions written to help an agent choose.
//
//   read   allglance_get_day · allglance_list_tasks · allglance_list_chores ·
//          allglance_list_milestones · allglance_list_users
//   write  allglance_create_task · allglance_update_task
//   plus   vikunja_native_find_action / do_action / filter_syntax (Vikunja's own
//          discovery tools, for anything the above cannot do)
//
// Writes go to where the task lives: Vikunja (shared household tasks) or
// dayGLANCE (the personal day plan, through its MCP). lastGLANCE and lifeGLANCE
// are read-only here: their apps own that data.

import { compactTask, compactBlock, compactChore, compactMilestone, byDue, today } from './format.js';

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const DATE = 'YYYY-MM-DD';

/** Turn transport failures into something an agent can act on (and not retry blindly). */
export function explain(err, source) {
  const msg = String(err?.message ?? err);
  const app = source === 'dayglance' ? 'dayGLANCE' : source === 'vikunja' ? 'Vikunja' : (source ?? 'a backing service');
  if (/-> (401|403) /.test(msg)) return new Error(`${app} refused the gateway's credentials (HTTP ${/-> (\d+) /.exec(msg)[1]}). The operator needs to check the API token in the gateway's configuration; retrying will not help.`);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? ?out|aborted/i.test(`${msg} ${err?.cause?.code ?? ''}`)) {
    return new Error(`${app} is temporarily unreachable. Nothing was changed; try again shortly.`);
  }
  return err;
}

export function buildTools(gw) {
  return [
    {
      name: 'allglance_get_day',
      description:
        'Show what is on for one day (default today): dayGLANCE time blocks in time order, plus open Vikunja tasks due that day, ' +
        'and a count of overdue tasks; with Omi wired in, also omi_day_summary (the wearable\'s end-of-day summary, null until that day is bundled). Use this for "what\'s on today/tomorrow?" questions. ' +
        'For longer lists or filtering use allglance_list_tasks; for chores use allglance_list_chores.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: `Day to show, ${DATE}. Defaults to today.` },
          owner_id: { type: 'string', description: 'Only this person\'s items (id from allglance_list_users). Omit for the whole household.' },
        },
      },
      handler: async ({ date, owner_id } = {}) => json(await gw.getDay(date ?? today(), owner_id ?? null)),
    },
    {
      name: 'allglance_list_tasks',
      description:
        'List tasks from Vikunja and dayGLANCE (inbox and scheduled). By default only open tasks, soonest due first, at most 50. ' +
        'Narrow with filters rather than reading everything. Each task shows its source and id; pass both to allglance_update_task. ' +
        'Not for chores (allglance_list_chores) or life milestones (allglance_list_milestones). ' +
        'For Vikunja-specific queries (labels, saved filters) use vikunja_native_find_action.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Default "open".' },
          source: { type: 'string', enum: ['vikunja', 'dayglance'], description: 'Only tasks from this app.' },
          owner_id: { type: 'string', description: 'Only this person\'s tasks (id from allglance_list_users).' },
          due_on_or_before: { type: 'string', description: `${DATE}. Tasks due on or before this day; use it for "overdue" (yesterday) or "this week". Undated tasks are excluded.` },
          due_on_or_after: { type: 'string', description: `${DATE}. Tasks due on or after this day. Undated tasks are excluded.` },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50. If more match, "truncated" is true: narrow the filters.' },
        },
      },
      handler: async (args = {}) => json(await gw.listTasks(args)),
    },
    {
      name: 'allglance_list_chores',
      description:
        'List recurring household chores from lastGLANCE: when each was last done, how often it should be (every_days), when it is next due, and whether it is overdue. ' +
        'Use for "what chores are overdue?" or "when did we last clean X?". Read-only: chores are logged in the lastGLANCE app ' +
        '(its "send to dayGLANCE" button turns an overdue chore into a day-plan task).',
      inputSchema: {
        type: 'object',
        properties: {
          overdue_only: { type: 'boolean', description: 'Only overdue chores. Default false.' },
          owner_id: { type: 'string', description: 'Only chores assigned to this person.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      handler: async (args = {}) => json(await gw.listChores(args)),
    },
    {
      name: 'allglance_list_milestones',
      description:
        'List life-timeline milestones from lifeGLANCE (dated life events such as "moved house"), most recent first. ' +
        'Use for questions about past or upcoming life events. Read-only. Optionally limit to a date range.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: `${DATE}. Milestones on or after this day.` },
          to: { type: 'string', description: `${DATE}. Milestones on or before this day.` },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      handler: async (args = {}) => json(await gw.listMilestones(args)),
    },
    {
      name: 'allglance_list_users',
      description:
        'List the household members known across the apps (id and name). Call it to turn a name ("Dad") into the owner_id the other tools take. Cheap; once per conversation is enough.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => json({ users: await gw.refreshRoster() }),
    },
    {
      name: 'allglance_create_task',
      description:
        'Create a task. Default source "vikunja": a shared household task in a Vikunja project (give due_date; optionally owner_id to assign someone). ' +
        'Use source "dayglance" for something that belongs on the personal day plan: give start ("YYYY-MM-DD HH:MM") to put it on the calendar, ' +
        'or omit start for an inbox task (only inbox tasks keep priority and due date). Returns the created task with its id. ' +
        'To change an existing task use allglance_update_task instead.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title, in the user\'s own words.' },
          source: { type: 'string', enum: ['vikunja', 'dayglance'], description: 'Default "vikunja".' },
          due_date: { type: 'string', description: `${DATE}. Vikunja due date, or a dayGLANCE inbox deadline.` },
          priority: { type: 'integer', minimum: 0, maximum: 5, description: '0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 do now. dayGLANCE only has 0-3 (higher is capped) and only on inbox tasks: ignored when start is given.' },
          owner_id: { type: 'string', description: 'Vikunja: assign to this person (id from allglance_list_users).' },
          project: { type: ['string', 'integer'], description: 'Vikunja: project name or id. Defaults to the household default project (Inbox).' },
          start: { type: 'string', description: 'dayGLANCE: "YYYY-MM-DD HH:MM" to schedule it on the calendar (or "YYYY-MM-DD" with all_day).' },
          duration_minutes: { type: 'integer', description: 'dayGLANCE: length when scheduled. Default 30.' },
          all_day: { type: 'boolean', description: 'dayGLANCE: an all-day item (start is then just the date).' },
          notes: { type: 'string', description: 'dayGLANCE: free-text notes.' },
        },
        required: ['title'],
      },
      handler: async (args) => {
        try {
          const { task, source } = await gw.createTask(args);
          return json({ created: compactTask(task), source });
        } catch (err) {
          throw explain(err, args?.source ?? 'vikunja');
        }
      },
    },
    {
      name: 'allglance_update_task',
      description:
        'Change an existing task where it lives: mark it done or not done, rename it, change its priority or due date, or (dayGLANCE) put it on the calendar with start. ' +
        'Needs the task\'s source and id from allglance_list_tasks or allglance_get_day. Only the fields you pass change. It cannot delete tasks. ' +
        'To create a new task use allglance_create_task.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['vikunja', 'dayglance'] },
          id: { type: 'string', description: 'The task id exactly as listed.' },
          done: { type: 'boolean', description: 'true = complete it, false = reopen it.' },
          title: { type: 'string', description: 'New title.' },
          priority: { type: 'integer', minimum: 0, maximum: 5, description: '0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 do now. dayGLANCE only has 0-3.' },
          due_date: { type: ['string', 'null'], description: `${DATE}, or null to clear the due date.` },
          start: { type: 'string', description: 'dayGLANCE only: "YYYY-MM-DD HH:MM" to schedule or move it on the calendar.' },
          duration_minutes: { type: 'integer', description: 'dayGLANCE only: length when scheduling.' },
          notes: { type: 'string', description: 'dayGLANCE only.' },
        },
        required: ['source', 'id'],
      },
      handler: async ({ source, id, ...patch }) => {
        try {
          const { task } = await gw.updateTask(source, id, patch);
          return json({ updated: compactTask(task) });
        } catch (err) {
          throw explain(err, source);
        }
      },
    },
  ];
}

export { byDue };
