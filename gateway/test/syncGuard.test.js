// The conditional-write guard in front of the WebDAV server: If-Match / If-None-Match are
// enforced for PUT/DELETE/MOVE, racing writers cannot both pass, everything else is untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSyncGuard, preconditionHolds } from '../src/syncGuard.js';

// A backend that behaves like hacdias/webdav: ETags change on write, and it IGNORES If-Match.
const files = new Map(); // path -> { body, v }
let seq = 0;
let writeDelayMs = 0;
const backend = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    if (req.headers.authorization !== 'Basic ok') { res.writeHead(401).end(); return; }
    const f = files.get(req.url);
    if (req.method === 'PUT') {
      if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
      files.set(req.url, { body: Buffer.concat(chunks).toString(), v: ++seq });
      res.writeHead(f ? 204 : 201, { etag: `"v${seq}"` }).end();
    } else if (req.method === 'DELETE') {
      if (!f) return void res.writeHead(404).end();
      files.delete(req.url); res.writeHead(204).end();
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      if (!f) return void res.writeHead(404).end();
      const etag = `"v${f.v}"`;
      if (req.headers['if-none-match'] === etag) return void res.writeHead(304, { etag }).end();
      res.writeHead(200, { etag }); res.end(req.method === 'GET' ? f.body : undefined);
    } else res.writeHead(405).end();
  });
});
let guard; let base; let dead;
const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request(`${base}${path}`, { method, headers: { authorization: 'Basic ok', ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', reject); r.end(body);
});

before(async () => {
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  guard = createSyncGuard({ backendPort: backend.address().port });
  await new Promise((r) => guard.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${guard.address().port}`;
});
after(() => { guard.close(); backend.close(); });

test('preconditionHolds: If-Match, If-None-Match, weak tags, lists', () => {
  assert.equal(preconditionHolds({ 'if-match': '"a"' }, '"a"'), true);
  assert.equal(preconditionHolds({ 'if-match': '"a"' }, '"b"'), false);
  assert.equal(preconditionHolds({ 'if-match': 'W/"a", "b"' }, '"b"'), true);
  assert.equal(preconditionHolds({ 'if-match': '*' }, '"a"'), true);
  assert.equal(preconditionHolds({ 'if-match': '*' }, null), false, 'If-Match needs an existing file');
  assert.equal(preconditionHolds({ 'if-none-match': '*' }, null), true);
  assert.equal(preconditionHolds({ 'if-none-match': '*' }, '"a"'), false);
  assert.equal(preconditionHolds({}, '"a"'), true);
});

test('unconditional writes and reads pass straight through', async () => {
  assert.equal((await call('PUT', '/free.json', { body: 'one' })).status, 201);
  const get = await call('GET', '/free.json');
  assert.equal(get.status, 200); assert.equal(get.body, 'one');
  assert.equal((await call('GET', '/free.json', { headers: { 'if-none-match': get.headers.etag } })).status, 304, 'the apps\' unchanged-poll 304 still works');
  assert.equal((await call('PUT', '/free.json', { body: 'two' })).status, 204, 'no precondition: last writer wins, as before');
});

test('If-Match: a stale ETag is refused and nothing is written; the current one is accepted', async () => {
  const first = await call('PUT', '/snap.json', { body: 'v1' });
  const etag = first.headers.etag;
  assert.equal((await call('PUT', '/snap.json', { body: 'other device', headers: { 'if-match': etag } })).status, 204);
  const stale = await call('PUT', '/snap.json', { body: 'lost update', headers: { 'if-match': etag } });
  assert.equal(stale.status, 412);
  assert.equal(files.get('/snap.json').body, 'other device', 'the stale write did not land');
  assert.ok(stale.headers.etag, 'the 412 names the current ETag');
});

test('If-Match on a missing file is refused; If-None-Match: * only creates', async () => {
  assert.equal((await call('PUT', '/nope.json', { body: 'x', headers: { 'if-match': '"v1"' } })).status, 412);
  assert.equal(files.has('/nope.json'), false);
  assert.equal((await call('PUT', '/new.json', { body: 'a', headers: { 'if-none-match': '*' } })).status, 201);
  assert.equal((await call('PUT', '/new.json', { body: 'b', headers: { 'if-none-match': '*' } })).status, 412);
  assert.equal(files.get('/new.json').body, 'a');
});

test('DELETE honours If-Match too', async () => {
  await call('PUT', '/del.json', { body: 'x' });
  assert.equal((await call('DELETE', '/del.json', { headers: { 'if-match': '"stale"' } })).status, 412);
  assert.equal(files.has('/del.json'), true);
  const etag = (await call('GET', '/del.json')).headers.etag;
  assert.equal((await call('DELETE', '/del.json', { headers: { 'if-match': etag } })).status, 204);
});

test('two devices racing with the same ETag: exactly one wins', async () => {
  const etag = (await call('PUT', '/race.json', { body: 'base' })).headers.etag;
  writeDelayMs = 40; // the backend is slow to commit, so the unguarded window would be wide
  try {
    const rs = await Promise.all(['A', 'B', 'C'].map((d) => call('PUT', '/race.json', { body: `from ${d}`, headers: { 'if-match': etag } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [204, 412, 412]);
  } finally { writeDelayMs = 0; }
});

test('credentials are the backend\'s call: a conditional write without them is 401, not 412', async () => {
  const r = await new Promise((resolve, reject) => {
    http.request(`${base}/snap.json`, { method: 'PUT', headers: { 'if-match': '"x"' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end('x');
  });
  assert.equal(r, 401);
});

test('backend down: 502', async () => {
  dead = createSyncGuard({ backendPort: 9 });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const status = await new Promise((resolve, reject) => {
    http.request(`http://127.0.0.1:${dead.address().port}/x`, { method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  dead.close();
  assert.equal(status, 502);
});
