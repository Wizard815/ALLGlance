// Priority on the canonical Task, vikunja task updates, and the gateway's
// PATCH /api/allglance/tasks/:source/:id route. fetch is stubbed; no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOf, priorityFromCaldav, priorityToCaldav } from '../src/model.js';
import { VikunjaAdapter } from '../src/adapters/VikunjaAdapter.js';
import { Roster } from '../src/identity/roster.js';
import Gateway from '../src/gateway.js';
import { requireToken } from '../src/server.js';

test('taskOf carries priority on the vikunja scale', () => {
  assert.equal(taskOf('vikunja', { id: 1, title: 'a', priority: 4 }).priority_label, 'urgent');
  assert.equal(taskOf('dayglance', { id: 2, title: 'b', priority: 3 }).priority_label, 'high');
  assert.equal(taskOf('lastglance', { id: 3, title: 'c' }).priority, 0);
  assert.equal(taskOf('vikunja', { id: 4, title: 'd', priority: 99 }).priority, 5);
});

test('CalDAV priority maps the way vikunja maps it', () => {
  // vikunja pkg/caldav/priority.go: low 9, medium 5, high 3, urgent 2, do now 1.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(priorityToCaldav), [0, 9, 5, 3, 2, 1]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(priorityFromCaldav), [0, 5, 4, 3, 3, 2, 1, 1, 1, 1]);
  for (const p of [0, 1, 2, 3, 4, 5]) assert.equal(priorityFromCaldav(priorityToCaldav(p)), p, `round trip ${p}`);
});

function vik() { return new VikunjaAdapter({ config: { vikunja: { enabled: true, url: 'http://v:3456', token: 't' } }, roster: new Roster() }); }

test('updateTask sends a JSON merge patch', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method, url: new URL(url).pathname, type: init.headers['content-type'], body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 42, title: 'Ship', done: true, priority: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const t = await vik().updateTask('42', { done: true, priority: 3, due_date: '2026-11-20' });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, '/api/v2/tasks/42');
  assert.equal(calls[0].type, 'application/merge-patch+json');
  assert.deepEqual(calls[0].body, { done: true, priority: 3, due_date: '2026-11-20T00:00:00Z' });
  assert.equal(t.completed, true); assert.equal(t.priority_label, 'high');
});

test('updateTask falls back to GET + PUT when PATCH is missing', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'; calls.push(method);
    if (method === 'PATCH') return new Response('no', { status: 405, statusText: 'Method Not Allowed' });
    if (method === 'GET') return new Response(JSON.stringify({ id: 7, title: 'Old', done: false, priority: 1, project_id: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(init.body);
    assert.deepEqual([body.title, body.done, body.priority, body.project_id], ['Old', true, 1, 2]);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await vik().updateTask(7, { done: true });
  assert.deepEqual(calls, ['PATCH', 'GET', 'PUT']);
});

test('PATCH /api/allglance/tasks/:source/:id routes to the source', async () => {
  const routes = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m, (path, handler) => routes.push({ m, path, handler })]));
  const gw = new Gateway();
  gw.registerRoutes(app, '/api/allglance');
  const route = routes.find((r) => r.m === 'patch' && r.path === '/api/allglance/tasks/:source/:id');
  assert.ok(route, 'route registered');
  assert.ok(routes.some((r) => r.path === '/api/allglance/vikunja/tasks'), 'adapter routes mounted under the base path');
  const call = async (source) => { let status = 200, payload; const res = { json: (d) => { payload = d; }, status: (c) => { status = c; return res; } };
    await route.handler({ params: { source, id: '9' }, body: { priority: 5 } }, res); return { status, payload }; };
  const day = await call('dayglance');
  assert.ok([501, 404].includes(day.status), `dayglance answered ${day.status}`);
  const nope = await call('nope');
  assert.equal(nope.status, 404);
});

test('requireToken accepts only the configured bearer token', () => {
  const mw = requireToken('s3cret');
  const run = (h) => { let code = 200, nexted = false; const res = { status: (c) => { code = c; return res; }, json: () => {} }; mw({ headers: { authorization: h } }, res, () => { nexted = true; }); return nexted ? 'next' : code; };
  assert.equal(run('Bearer s3cret'), 'next');
  assert.equal(run('Bearer nope'), 401);
  assert.equal(run(undefined), 401);
});

test('dayGLANCE blocks from the MCP keep their owner (assignee_id)', async () => {
  const { DayglanceAdapter } = await import('../src/adapters/DayglanceAdapter.js');
  const a = new DayglanceAdapter({ config: { dayglance: { enabled: true, webUrl: 'http://x' }, playwright: { headless: true, timeoutMs: 1000 } }, roster: new Roster(), reader: { read: async () => ({}) } });
  a.setTransport({ read: async () => ({ blocks: [{ id: 't1', type: 'task', title: 'Standup', date: '2026-11-05', start_time: '09:30', assignee_id: 'dad' }, { id: 't2', type: 'task', title: 'Nobody', date: '2026-11-05' }] }) }, 'mcp');
  const all = await a.readBlocks('2026-11-05');
  assert.equal(all.blocks.find((b) => b.id === 't1').owner_id, 'dad');
  assert.equal(all.blocks.find((b) => b.id === 't2').owner_id, null);
  const mine = await a.readBlocks('2026-11-05', 'dad');
  assert.deepEqual(mine.blocks.map((b) => b.id), ['t1']);
});
