// The supervisor that runs the gateway, dayGLANCE MCP and WebDAV server in one container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { supervise } from '../supervisor.mjs';

function fakeSpawner() {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = []; child.cmd = cmd; child.args = args; child.env = opts.env;
    child.kill = (sig) => { child.killed.push(sig); setImmediate(() => child.emit('exit', null, sig)); };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('starts every service, prefixes their logs, and passes per-service env', async () => {
  const f = fakeSpawner(); const logs = [];
  const sup = supervise([{ name: 'a', cmd: 'x', args: ['1'] }, { name: 'b', cmd: 'y', env: { FOO: 'bar' } }], { spawn: f.spawn, log: (m) => logs.push(m) });
  assert.equal(f.spawned.length, 2);
  assert.equal(f.spawned[1].env.FOO, 'bar');
  f.spawned[0].stdout.write('hello\nwor'); f.spawned[0].stdout.write('ld\n');
  await wait(5);
  assert.ok(logs.includes('[a] hello') && logs.includes('[a] world'));
  await sup.stop();
});

test('a crashed service is restarted with growing (capped) backoff; the others are left alone', async () => {
  const f = fakeSpawner(); const logs = [];
  const sup = supervise([{ name: 'flaky', cmd: 'x' }, { name: 'steady', cmd: 'y' }], { spawn: f.spawn, log: (m) => logs.push(m), minBackoffMs: 20, maxBackoffMs: 60, stableMs: 10_000 });
  f.spawned[0].emit('exit', 1, null);                       // crash 1 -> restart in 20 ms
  await wait(45); assert.equal(f.spawned.length, 3, 'restarted once');
  f.spawned[2].emit('exit', 1, null);                       // crash 2 -> 40 ms
  await wait(25); assert.equal(f.spawned.length, 3, 'still waiting (backoff grew)');
  await wait(40); assert.equal(f.spawned.length, 4, 'restarted twice');
  f.spawned[3].emit('exit', 1, null);                       // crash 3 -> capped at 60 ms
  await wait(75); assert.equal(f.spawned.length, 5);
  assert.equal(f.spawned[1].killed.length, 0, 'the healthy service was never touched');
  assert.ok(logs.some((l) => /flaky exited.*restarting in 20 ms/.test(l)));
  await sup.stop();
});

test('stop terminates every child, cancels pending restarts, and never restarts afterwards', async () => {
  const f = fakeSpawner();
  const sup = supervise([{ name: 'a', cmd: 'x' }, { name: 'b', cmd: 'y' }], { spawn: f.spawn, log: () => {}, minBackoffMs: 30 });
  f.spawned[0].emit('exit', 1, null);                       // a restart is now pending
  await sup.stop();
  assert.deepEqual(f.spawned[1].killed, ['SIGTERM']);
  await wait(60);
  assert.equal(f.spawned.length, 2, 'no restart after stop');
});
