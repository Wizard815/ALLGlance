// VikunjaAdapter against the /api/v2 shapes (items envelope, page/per_page,
// assignees[], due_date). fetch is stubbed; no server needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VikunjaAdapter } from '../src/adapters/VikunjaAdapter.js';
import { Roster } from '../src/identity/roster.js';

function adapter() {
  const a = new VikunjaAdapter({
    config: { vikunja: { enabled: true, url: 'http://v:3456', token: 't' } },
    roster: new Roster(),
  });
  return a;
}

function stubFetch(routes, calls) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.search}`);
    const body = routes(u, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('readTasks pages through projects and tasks via page/total_pages', async () => {
  const calls = [];
  stubFetch((u) => {
    if (u.pathname === '/api/v2/projects') return { items: [{ id: 1 }, { id: 2, is_archived: true }], total_pages: 1 };
    const page = Number(u.searchParams.get('page'));
    return {
      total_pages: 2,
      items: [{ id: page * 10, title: `t${page}`, due_date: '0001-01-01T00:00:00Z', assignees: [{ id: 7, username: 'dad', name: 'Dad' }] }],
    };
  }, calls);
  const { tasks } = await adapter().readTasks();
  assert.deepEqual(tasks.map((t) => t.title), ['t1', 't2']);
  assert.equal(tasks[0].due_date, null);
  assert.equal(tasks[0].owner_id, '7');
  assert.ok(!calls.some((c) => c.includes('/projects/2/')), 'archived project skipped');
});

test('writeTask posts to the project route with due_date, then assigns', async () => {
  const calls = [];
  const bodies = [];
  stubFetch((u, init) => {
    bodies.push(init.body);
    return { id: 99, title: 'x', due_date: '2026-11-05T00:00:00Z' };
  }, calls);
  const t = await adapter().writeTask({ title: 'x', due_date: '2026-11-05', project_id: 3, owner_id: '7' });
  assert.equal(calls[0], 'POST /api/v2/projects/3/tasks');
  assert.equal(JSON.parse(bodies[0]).due_date, '2026-11-05T00:00:00Z');
  assert.equal(calls[1], 'POST /api/v2/tasks/99/assignees');
  assert.equal(t.title, 'x');
});

test('writeTask carries notes as the Vikunja description (Omi action items send them)', async () => {
  const bodies = [];
  stubFetch((u, init) => { bodies.push(init.body); return { id: 5, title: 'x' }; }, []);
  await adapter().writeTask({ title: 'x', notes: 'call the dentist', project_id: 3 });
  assert.equal(JSON.parse(bodies[0]).description, 'call the dentist');
});

test('status checks /health then an authenticated read', async () => {
  const calls = [];
  stubFetch(() => ({ items: [] }), calls);
  const s = await adapter().status();
  assert.equal(s.ok, true);
  assert.deepEqual(calls.map((c) => c.split('?')[0]), ['GET /health', 'GET /api/v2/projects']);
});
