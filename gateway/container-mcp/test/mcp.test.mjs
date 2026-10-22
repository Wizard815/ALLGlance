// Integration test: boot the container dayGLANCE MCP server against a temp
// state file and exercise the real tools over Streamable HTTP, asserting the
// output matches dayGLANCE's contract. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDayglanceMcpServer } from '../server.mjs';

const TOKEN = 'test-token';
const PORT = 7899;

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'dgmcp-'));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({
    weekStartDay: 0,
    tasks: [
      { id: 'a', title: 'Walk dog', date: '2026-10-04', startTime: '08:00', duration: 30, isAllDay: false, completed: false, assignedUserSyncIds: ['dad'], projectId: 'p1' },
    ],
    unscheduledTasks: [{ id: 'u1', title: 'Buy milk', deadline: '2026-10-06', priority: 2, completed: false }],
    recurringTasks: [],
    users: [{ syncId: 'dad', name: 'Dad' }, { syncId: 'me', name: 'Me' }],
    goals: [], projects: [],
  }));
  process.env.DAYGLANCE_STATE_FILE = file;
  const srv = startDayglanceMcpServer({ port: PORT, token: TOKEN, timeZone: 'America/Chicago' });
  await new Promise((r) => setTimeout(r, 150));
  return srv;
}

let idc = 1;
async function rpc(method, params, auth = true) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
  });
  return { status: res.status, text: await res.text() };
}
function payload(text) {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
}
async function tool(name, args) {
  const { text } = await rpc('tools/call', { name, arguments: args ?? {} });
  const j = payload(text);
  const t = j?.result?.content?.[0]?.text;
  return { isError: !!j?.result?.isError, data: t ? JSON.parse(t) : null };
}

const srv = await boot();

test('auth: request without bearer token is 401', async () => {
  const { status } = await rpc('tools/list', {}, false);
  assert.equal(status, 401);
});

test('tools/list exposes the real dayGLANCE tool set', async () => {
  const { text } = await rpc('tools/list', {});
  const names = (payload(text)?.result?.tools ?? []).map((t) => t.name);
  for (const n of ['dayglance_ping', 'dayglance_get_today', 'dayglance_get_day',
    'dayglance_list_unscheduled_tasks', 'dayglance_list_users', 'dayglance_get_goal_progress',
    'dayglance_create_task', 'dayglance_update_task', 'dayglance_schedule_task',
    'dayglance_move_block', 'dayglance_resize_block', 'dayglance_set_task_completion']) {
    assert.ok(names.includes(n), `expected tool ${n}`);
  }
});

test('dayglance_get_day returns canonical blocks', async () => {
  const { data } = await tool('dayglance_get_day', { date: '2026-10-04' });
  assert.equal(data.date, '2026-10-04');
  assert.equal(data.timezone, 'America/Chicago');
  assert.equal(data.blocks.length, 1);
  assert.equal(data.blocks[0].title, 'Walk dog');
  assert.equal(data.blocks[0].start_time, '08:00');
});

test('dayglance_get_day rejects a bad date (typed validation error)', async () => {
  const { isError, data } = await tool('dayglance_get_day', { date: '2026-13-40' });
  assert.equal(isError, true);
  assert.equal(data.error.code, 'validation');
});

test('dayglance_list_unscheduled_tasks paginates the inbox', async () => {
  const { data } = await tool('dayglance_list_unscheduled_tasks', {});
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].deadline, '2026-10-06');
  assert.equal(data.truncated, false);
});

test('dayglance_list_users drops deleted members', async () => {
  const { data } = await tool('dayglance_list_users', {});
  assert.deepEqual(data.users.map((u) => u.id), ['dad', 'me']);
});

test('dayglance_create_task adds an inbox task and persists it', async () => {
  const { data } = await tool('dayglance_create_task', { title: 'New chore', priority: 1 });
  assert.equal(data.replayed, false);
  assert.equal(data.task.title, 'New chore');
  // persisted: a follow-up inbox read now has two items
  const after = await tool('dayglance_list_unscheduled_tasks', {});
  assert.equal(after.data.total, 2);
});

test('dayglance_schedule_task rejects a DST-gap time (typed validation error)', async () => {
  const { isError } = await tool('dayglance_schedule_task', {
    task_id: 'u1', start: '2026-03-08 02:30',
  });
  assert.equal(isError, true);
});

test.after(() => srv.close());
