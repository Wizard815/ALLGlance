// Integration test: the gateway's DayglanceMcpClient must be able to talk to
// the containerized dayGLANCE MCP server — this is the "two talking" path.
// (Regression guard for the SSE-vs-JSON parsing fix in the client.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDayglanceMcpServer } from '../server.mjs';
import { DayglanceMcpClient } from '../../src/transport/DayglanceMcpClient.js';

const PORT = 7901;
const TOKEN = 'shared-secret';

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'dg-int-'));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({
    weekStartDay: 0,
    tasks: [{ id: 'a', title: 'Walk dog', date: '2026-10-04', startTime: '08:00', duration: 30, isAllDay: false, completed: false }],
    unscheduledTasks: [{ id: 'u1', title: 'Buy milk', completed: false }],
    recurringTasks: [],
    users: [{ syncId: 'dad', name: 'Dad' }],
    goals: [], projects: [],
  }));
  process.env.DAYGLANCE_STATE_FILE = file;
  const srv = startDayglanceMcpServer({ port: PORT, token: TOKEN, timeZone: 'America/Chicago' });
  await new Promise((r) => setTimeout(r, 150));
  return srv;
}

const srv = await boot();
const client = new DayglanceMcpClient({ host: '127.0.0.1', port: PORT, token: TOKEN });

test('gateway client reports the container MCP healthy', async () => {
  const s = await client.status();
  assert.equal(s.ok, true);
});

test('gateway client reads state from the container MCP (SSE parsed)', async () => {
  const state = await client.read('today');
  assert.ok(Array.isArray(state.tasks));
  assert.ok(Array.isArray(state.blocks));
  assert.equal(state.users[0].id, 'dad');
  // the inbox task rides the tasks array
  assert.equal(state.tasks.find((t) => t.id === 'u1').title, 'Buy milk');
});

test('gateway client can call a specific day', async () => {
  const day = await client.readDay('2026-10-04');
  assert.equal(day.blocks.length, 1);
  assert.equal(day.blocks[0].title, 'Walk dog');
});

test.after(() => srv.close());
