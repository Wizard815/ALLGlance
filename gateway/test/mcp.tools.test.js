// The agent-facing MCP surface: few tools, clear wording, compact output, and
// writes that reach both Vikunja and dayGLANCE.
import { describe, it, beforeEach } from 'node:test';
import { equal, ok, deepEqual, match, rejects } from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { Roster } from '../src/identity/roster.js';
import { DayglanceAdapter } from '../src/adapters/DayglanceAdapter.js';
import { VikunjaAdapter } from '../src/adapters/VikunjaAdapter.js';
import { taskOf } from '../src/model.js';
import { explain } from '../src/mcp/tools.js';

const T = (source, id, title, extra = {}) => taskOf(source, { id, title, ...extra }, extra.owner ?? null);

function gatewayWith({ tasks = {}, blocks = [], chores = [], milestones = [] } = {}) {
  const gw = new Gateway();
  for (const a of gw.adapters()) {
    a.readTasks = async () => ({ tasks: tasks[a.source] ?? [] });
    if (a.source === 'dayglance') a.readBlocks = async () => ({ blocks });
    if (a.source === 'lastglance') a.readChores = async () => ({ chores });
    if (a.source === 'lifeglance') a.readMilestones = async () => ({ milestones });
  }
  return gw;
}
const tool = (gw, name) => gw.registerMcpTools().find((t) => t.name === name);
const run = async (gw, name, args) => JSON.parse((await tool(gw, name).handler(args)).content[0].text);

describe('tool surface', () => {
  it('is small, namespaced, and every tool tells the agent when to use it', () => {
    const tools = new Gateway().registerMcpTools();
    deepEqual(tools.map((t) => t.name).sort(), [
      'allglance_create_task', 'allglance_get_day', 'allglance_list_chores',
      'allglance_list_milestones', 'allglance_list_tasks', 'allglance_list_users', 'allglance_update_task',
    ]);
    for (const t of tools) {
      ok(t.description.length > 80 && t.description.length < 700, `${t.name} description length`);
      for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) {
        ok(p.description || p.enum, `${t.name}.${k} needs a description or enum`);
      }
    }
    // Cross-references steer the agent to the right sibling.
    match(tool(new Gateway(), 'allglance_list_tasks').description, /allglance_update_task/);
    match(tool(new Gateway(), 'allglance_update_task').description, /allglance_create_task/);
    match(tool(new Gateway(), 'allglance_get_day').description, /allglance_list_tasks/);
    match(tool(new Gateway(), 'allglance_create_task').description, /source "dayglance"/);
  });
});

describe('reads', () => {
  it('list_tasks: open by default, soonest due first, compact (no raw record), source+id present', async () => {
    const gw = gatewayWith({ tasks: {
      vikunja: [T('vikunja', '1', 'Later', { due_date: '2026-11-20' }), T('vikunja', '2', 'Done one', { completed: true, due_date: '2026-11-01' }), T('vikunja', '3', 'Undated')],
      dayglance: [T('dayglance', 'a', 'Soon', { date: '2026-11-06', priority: 3 })],
    } });
    const r = await run(gw, 'allglance_list_tasks', {});
    deepEqual(r.tasks.map((t) => t.title), ['Soon', 'Later', 'Undated']);
    equal(r.total, 3);
    ok(!('extra' in r.tasks[0]));
    deepEqual(Object.keys(r.tasks[0]).sort(), ['done', 'due', 'id', 'priority', 'priority_label', 'source', 'title']);
    equal((await run(gw, 'allglance_list_tasks', { status: 'done' })).tasks[0].title, 'Done one');
    equal((await run(gw, 'allglance_list_tasks', { source: 'dayglance' })).tasks.length, 1);
    deepEqual((await run(gw, 'allglance_list_tasks', { due_on_or_before: '2026-11-10' })).tasks.map((t) => t.title), ['Soon']);
    const lim = await run(gw, 'allglance_list_tasks', { limit: 1 });
    equal(lim.truncated, true);
    equal(lim.returned, 1);
  });

  it('get_day: blocks in time order, tasks due that day (no double counting), overdue count', async () => {
    const gw = gatewayWith({
      blocks: [{ id: 'b2', type: 'task', title: 'Lunch', date: '2026-11-06', start_time: '12:00', duration_minutes: 60 }, { id: 'b1', type: 'task', title: 'Dentist', date: '2026-11-06', start_time: '10:00' }],
      tasks: {
        vikunja: [T('vikunja', '1', 'Due today', { due_date: '2026-11-06' }), T('vikunja', '2', 'Overdue', { due_date: '2026-11-01' }), T('vikunja', '3', 'Tomorrow', { due_date: '2026-11-07' })],
        dayglance: [T('dayglance', 'b1', 'Dentist', { date: '2026-11-06' })], // also a block: must not repeat
      },
    });
    const d = await run(gw, 'allglance_get_day', { date: '2026-11-06' });
    deepEqual(d.blocks.map((b) => b.title), ['Dentist', 'Lunch']);
    deepEqual(d.tasks.map((t) => t.title), ['Due today']);
    equal(d.overdue_count, 1);
  });

  it('list_chores / list_milestones: filters, ordering, compact', async () => {
    const gw = gatewayWith({
      chores: [{ id: 'c1', title: 'Wash car', overdue: false, due_date: '2026-12-01', last_completed: '2026-11-01T10:00:00.000Z', target_cadence_days: 30 }, { id: 'c2', title: 'Mop', overdue: true, due_date: '2026-10-01', last_completed: '2026-09-17T00:00:00.000Z', target_cadence_days: 14, extra: { big: 1 } }],
      milestones: [{ id: 'm1', title: 'Old', date: '2020-01-01' }, { id: 'm2', title: 'New', date: '2024-06-15', note: 'x'.repeat(500) }],
    });
    const c = await run(gw, 'allglance_list_chores', {});
    deepEqual(c.chores.map((x) => x.title), ['Mop', 'Wash car']); // overdue first
    equal(c.chores[0].last_done, '2026-09-17');
    ok(!('extra' in c.chores[0]));
    deepEqual((await run(gw, 'allglance_list_chores', { overdue_only: true })).chores.map((x) => x.title), ['Mop']);
    const m = await run(gw, 'allglance_list_milestones', {});
    deepEqual(m.milestones.map((x) => x.title), ['New', 'Old']); // most recent first
    equal(m.milestones[0].note.length, 200);
    deepEqual((await run(gw, 'allglance_list_milestones', { from: '2022-01-01' })).milestones.map((x) => x.title), ['New']);
  });
});

describe('dayGLANCE writes go through its MCP', () => {
  let calls, adapter;
  beforeEach(() => {
    calls = [];
    adapter = new DayglanceAdapter({ roster: new Roster(), config: { dayglance: { enabled: true, webUrl: 'x' }, playwright: {} } });
    adapter.setTransport({
      read: async () => ({}),
      call: async (name, args) => { calls.push([name, args]); return name === 'dayglance_create_task' ? { task: { id: 'n1', title: args.title, priority: args.priority ?? 0 } } : { block: { id: args.task_id, title: 'X', completed: args.completed ?? false } }; },
    }, 'mcp');
  });

  it('create: with start -> scheduled; without -> inbox with deadline; priority capped to dayGLANCE\'s 0-3', async () => {
    await adapter.writeTask({ title: 'Plan', start: '2026-11-07 09:00', duration_minutes: 45, priority: 5 });
    deepEqual(calls[0], ['dayglance_create_task', { title: 'Plan', start: '2026-11-07 09:00', duration_minutes: 45 }]); // scheduled: no priority (dayGLANCE rejects it)
    await adapter.writeTask({ title: 'Inbox', due_date: '2026-11-09', priority: 9 });
    deepEqual(calls[1], ['dayglance_create_task', { title: 'Inbox', priority: 3, deadline: '2026-11-09' }]);
    // a household member (Omi's family calendar binds its events to one): dayGLANCE's assignee_id
    await adapter.writeTask({ title: 'Inspection', start: '2026-11-13 11:00', duration_minutes: 60, owner_id: 'u-sam', notes: 'landlord' });
    deepEqual(calls[2], ['dayglance_create_task', { title: 'Inspection', notes: 'landlord', assignee_id: 'u-sam', start: '2026-11-13 11:00', duration_minutes: 60 }]);
  });

  it('update maps done / title+priority+due / start onto the right dayGLANCE tools', async () => {
    await adapter.updateTask('t1', { done: true });
    deepEqual(calls[0], ['dayglance_set_task_completion', { task_id: 't1', completed: true }]);
    calls.length = 0;
    await adapter.updateTask('t1', { title: 'New', priority: 9, due_date: null, start: '2026-11-08 14:00' });
    deepEqual(calls.map((c) => c[0]), ['dayglance_update_task', 'dayglance_schedule_task']);
    deepEqual(calls[0][1], { task_id: 't1', title: 'New', priority: 3, clear_fields: ['deadline'] });
    await rejects(adapter.updateTask('t1', {}), /nothing to update/);
  });

  it('without the MCP transport it says so', async () => {
    const bare = new DayglanceAdapter({ roster: new Roster(), config: { dayglance: { enabled: true, webUrl: 'x' }, playwright: {} } });
    await rejects(bare.writeTask({ title: 'x' }), /MCP transport/);
  });
});

describe('vikunja project resolution', () => {
  const projects = [{ id: 1, title: 'Inbox' }, { id: 7, title: 'Household' }];
  const mk = (defaultProjectId = '') => {
    const posts = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (init.method === 'POST') { posts.push(u.pathname); return new Response(JSON.stringify({ id: 99, title: 'x' }), { headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify({ items: projects, total_pages: 1 }), { headers: { 'content-type': 'application/json' } });
    };
    return { posts, a: new VikunjaAdapter({ roster: new Roster(), config: { vikunja: { enabled: true, url: 'http://v', token: 't', defaultProjectId, mcp: { enabled: false } }, playwright: {} } }) };
  };
  it('name, id, configured default, and first-project fallback', async () => {
    let { a, posts } = mk(); await a.writeTask({ title: 'a', project: 'household' }); equal(posts.at(-1), '/api/v2/projects/7/tasks');
    await a.writeTask({ title: 'b', project: 3 }); equal(posts.at(-1), '/api/v2/projects/3/tasks');
    await a.writeTask({ title: 'c' }); equal(posts.at(-1), '/api/v2/projects/1/tasks');
    ({ a, posts } = mk('7')); await a.writeTask({ title: 'd' }); equal(posts.at(-1), '/api/v2/projects/7/tasks');
    await rejects(a.writeTask({ title: 'e', project: 'Nope' }), /No Vikunja project named "Nope".*Inbox, Household/);
  });
});

describe('dates', () => {
  it('Vikunja\'s zero date means "no due date" (and must not sort first)', async () => {
    const t = taskOf('vikunja', { id: 1, title: 'x', due_date: '0001-01-01T00:00:00Z' }, null);
    equal(t.due_date, null);
  });
});

describe('vikunja roster', () => {
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  it('lists project users (so list_users is not empty before any task is read), and survives a 401', async () => {
    const roster = new Roster();
    const a = new VikunjaAdapter({ roster, config: { vikunja: { enabled: true, url: 'http://v', token: 't', mcp: { enabled: false } }, playwright: {} } });
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/v2/projects') return json({ items: [{ id: 2 }, { id: 3, is_archived: true }], total_pages: 1 });
      if (u.pathname === '/api/v2/projects/2/users/search') return json({ items: [{ id: 1, username: 'dad', name: 'Dad' }, { id: 2, username: 'mum', name: '' }], total_pages: 1 });
      return new Response('{}', { status: 404 });
    };
    deepEqual((await a.refreshRoster()).map((p) => p.name).sort(), ['Dad', 'mum']);
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    equal((await a.refreshRoster()).length, 2, 'a 401 keeps what we know and does not throw');
  });
});

describe('partial answers are labelled', () => {
  it('list_tasks / get_day say which source was unreachable instead of silently omitting it', async () => {
    const gw = gatewayWith({ tasks: { vikunja: [T('vikunja', '1', 'V', { due_date: '2026-11-06' })] } });
    const day = gw.adapters().find((a) => a.source === 'dayglance');
    day.readTasks = async () => { throw new Error('fetch failed'); };
    day.readBlocks = async () => { throw new Error('fetch failed'); };
    const r = await run(gw, 'allglance_list_tasks', {});
    deepEqual(r.unavailable, ['dayglance']);
    match(r.note, /leaves them out/);
    equal(r.total, 1);
    const d = await run(gw, 'allglance_get_day', { date: '2026-11-06' });
    deepEqual(d.unavailable, ['dayglance']);
    equal(d.tasks.length, 1);
    equal('unavailable' in (await run(gatewayWith({}), 'allglance_list_tasks', {})), false, 'no noise when everything answered');
  });

  it('a dayGLANCE write that cannot connect says so in plain words', async () => {
    const a = new DayglanceAdapter({ roster: new Roster(), config: { dayglance: { enabled: true, webUrl: 'x' }, playwright: {} } });
    a.setTransport({ read: async () => ({}), call: async () => { throw new TypeError('fetch failed'); } }, 'mcp');
    await rejects(a.writeTask({ title: 'x' }), /temporarily unreachable.*not changed/);
  });
});

describe('error wording', () => {
  it('connection failures and refused credentials become actionable sentences', () => {
    match(explain(new TypeError('fetch failed'), 'vikunja').message, /Vikunja is temporarily unreachable.*Nothing was changed/);
    match(explain(new Error('POST http://v/api/v2/tasks -> 401 Unauthorized'), 'vikunja').message, /refused the gateway's credentials \(HTTP 401\).*retrying will not help/);
    const other = new Error('title must not be empty');
    equal(explain(other, 'vikunja'), other, 'domain errors pass through untouched');
  });
});

describe('dayGLANCE reads cover every scheduled day', () => {
  it('list_tasks sees tasks scheduled weeks ahead (the MCP alone only reads one day at a time)', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'dgsnap-'));
    await mkdir(join(dir, 'dayglance'));
    const file = join(dir, 'dayglance', 'dayglance-sync.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, appId: 'dayglance', version: 2, data: {
      tasks: [{ id: 'a', title: 'Dentist', date: '2026-12-24', startTime: '10:00', duration: 45, completed: false }],
      unscheduledTasks: [{ id: 'b', title: 'Call plumber', priority: 2, completed: false }],
      users: [],
    } }));
    const adapter = new DayglanceAdapter({ roster: new Roster(), config: { dayglance: { enabled: true, webUrl: 'x' }, playwright: {}, sync: { dir, dayglanceFile: file, passphrase: '' } } });
    adapter.setTransport({ read: async () => ({ tasks: [], blocks: [] }) }, 'mcp'); // MCP view is empty: today has nothing
    const { tasks } = await adapter.readTasks();
    deepEqual(tasks.map((t) => t.title).sort(), ['Call plumber', 'Dentist']);
    equal(tasks.find((t) => t.title === 'Dentist').due_date, '2026-12-24');
    // An unreadable snapshot falls back to the MCP instead of failing.
    await writeFile(file, '{not json');
    deepEqual((await adapter.readTasks()).tasks, []);
  });
});

describe('idempotent updates', () => {
  it('re-applying an update that changes nothing (Vikunja answers 304) is success, not an error', async () => {
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
      if (init.method === 'PATCH') return new Response(null, { status: 304, statusText: 'Not Modified' });
      return json({ id: 7, title: 'Already done', done: true });
    };
    const a = new VikunjaAdapter({ roster: new Roster(), config: { vikunja: { enabled: true, url: 'http://v', token: 't', mcp: { enabled: false } }, playwright: {} } });
    const t = await a.updateTask(7, { done: true });
    equal(t.completed, true);
    equal(t.title, 'Already done');
    deepEqual(calls, ['PATCH /api/v2/tasks/7', 'GET /api/v2/tasks/7']);
  });
});
