// The MCP backed by dayGLANCE's own WebDAV sync snapshot (dayglance-sync.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncFileStore, parseSnapshot, applyListDiff } from '../syncFileStore.mjs';
import { startDayglanceMcpServer } from '../server.mjs';

const snapshot = (data) => ({ schemaVersion: 1, appId: 'dayglance', version: 2, lastModified: '2026-11-05T00:00:00.000Z', data });
async function tmpFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'dgsync-'));
  const file = join(dir, 'dayglance-sync.json');
  if (doc) await writeFile(file, JSON.stringify(doc));
  return file;
}
const read = async (f) => JSON.parse(await readFile(f, 'utf8'));

test('parseSnapshot rejects an encrypted/unknown envelope with a helpful message', () => {
  assert.throws(() => parseSnapshot('{"encrypted":true,"iv":"x"}'), /end-to-end encryption/);
  assert.throws(() => parseSnapshot('nope'), /not valid JSON/);
});

test('applyListDiff applies only this write’s changes onto the latest list', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const draft = [{ id: 'a', v: 2 }, { id: 'c', v: 1 }]; // changed a, removed b, added c
  const latest = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'app-new', v: 1 }]; // app added a task meanwhile
  const out = applyListDiff(base, draft, latest);
  assert.deepEqual(out.map((t) => `${t.id}${t.v}`).sort(), ['a2', 'app-new1', 'c1']);
});

test('commit writes only changed slices, preserves every other field, keeps concurrent app edits', async () => {
  const file = await tmpFile(snapshot({
    tasks: [{ id: 't1', title: 'One', date: '2026-11-06', startTime: '10:00', completed: false }],
    unscheduledTasks: [], recurringTasks: [], recycleBin: [],
    routineDefinitions: { monday: [1] }, deletedTaskIds: { x: 'y' },
  }));
  const store = createSyncFileStore({ file, now: () => '2026-11-05T09:00:00.000Z' });
  const { state, setters } = await store.beginWrite();
  setters.setTasks([...state.tasks, { id: 't2', title: 'Two', date: '2026-11-07', startTime: '09:00', completed: false }]);

  // The app syncs a new task while our write is in flight.
  const cur = await read(file);
  cur.data.unscheduledTasks.push({ id: 'app1', title: 'From app' });
  await writeFile(file, JSON.stringify(cur));

  await store.commit();
  const out = await read(file);
  assert.deepEqual(out.data.tasks.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(out.data.unscheduledTasks.map((t) => t.id), ['app1']);
  assert.deepEqual(out.data.routineDefinitions, { monday: [1] });
  assert.deepEqual(out.data.deletedTaskIds, { x: 'y' });
  assert.equal(out.lastModified, '2026-11-05T09:00:00.000Z');
  assert.equal(out.appId, 'dayglance');
});

test('no-op write leaves the file untouched; missing file starts empty and is created on first write', async () => {
  const file = await tmpFile(null);
  const store = createSyncFileStore({ file });
  assert.deepEqual((await store.get()).state.tasks, []);
  const { setters } = await store.beginWrite();
  await store.commit(); // nothing changed
  await assert.rejects(readFile(file), /ENOENT/);
  const w = await store.beginWrite();
  w.setters.setUnscheduledTasks([{ id: 'n1', title: 'New' }]);
  await store.commit();
  const out = await read(file);
  assert.equal(out.appId, 'dayglance');
  assert.deepEqual(out.data.unscheduledTasks.map((t) => t.id), ['n1']);
});

test('MCP over the sync file: reads app data; create_task mints an id and persists', async () => {
  const file = await tmpFile(snapshot({
    tasks: [{ id: 'a', title: 'Dentist', date: '2026-11-06', startTime: '10:00', duration: 45, isAllDay: false, completed: false }],
    unscheduledTasks: [], recurringTasks: [], recycleBin: [],
  }));
  const srv = startDayglanceMcpServer({ port: 7898, token: 't', timeZone: 'UTC', syncFile: file, log: () => {} });
  await new Promise((r) => setTimeout(r, 150));
  const call = async (name, args) => {
    const res = await fetch('http://127.0.0.1:7898/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer t' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const line = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line.slice(5)).result.structuredContent;
  };
  try {
    const day = await call('dayglance_get_day', { date: '2026-11-06' });
    assert.equal(day.blocks[0].title, 'Dentist');
    await call('dayglance_create_task', { title: 'Book flights', start: '2026-11-07 09:00', duration_minutes: 30 });
    await call('dayglance_create_task', { title: 'Renew passport' });
    const out = await read(file);
    const flights = out.data.tasks.find((t) => t.title === 'Book flights');
    const passport = out.data.unscheduledTasks.find((t) => t.title === 'Renew passport');
    assert.ok(flights?.id && passport?.id, 'created tasks must carry ids');
    assert.ok(flights.lastModified, 'created tasks are stamped so the app’s merge accepts them');
    await call('dayglance_set_task_completion', { task_id: 'a', completed: true });
    assert.equal((await read(file)).data.tasks.find((t) => t.id === 'a').completed, true);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('a changed task whose lastModified did not advance is stamped (completion would otherwise lose the merge)', () => {
  const base = [{ id: 'a', completed: false, lastModified: '2026-11-05T01:00:00.000Z' }];
  const draft = [{ id: 'a', completed: true, lastModified: '2026-11-05T01:00:00.000Z' }];
  const out = applyListDiff(base, draft, base, '2026-11-05T09:00:00.000Z');
  assert.equal(out[0].completed, true);
  assert.equal(out[0].lastModified, '2026-11-05T09:00:00.000Z');
  // An already-advanced stamp is preserved.
  const adv = [{ id: 'a', completed: true, lastModified: '2026-11-05T05:00:00.000Z' }];
  assert.equal(applyListDiff(base, adv, base, '2026-11-05T09:00:00.000Z')[0].lastModified, '2026-11-05T05:00:00.000Z');
});
