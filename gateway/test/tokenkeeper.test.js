// The Vikunja token keeper (renews the gateway's API token) and signing in to CalDAV with a gateway token.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VikunjaTokenKeeper, TITLE, DEFAULT_PERMISSIONS } from '../src/vikunjaTokenKeeper.js';
import { createCaldavProxy } from '../src/caldavProxy.js';
import { loadOverrides } from '../src/adminSettings.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const quiet = { log() {}, warn() {} };

/** A small Vikunja: login, list/create/delete API tokens, and a projects read that checks the token. */
function fakeVikunja({ password = 'pw', tokens = [] } = {}) {
  const st = { tokens: tokens.map((t) => ({ ...t })), nextId: 10, calls: [], loginOk: true, refuseNewToken: false };
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname.replace('/api/v1', ''); const m = init.method ?? 'GET';
    const auth = String(init.headers?.authorization ?? '').replace('Bearer ', '');
    st.calls.push(`${m} ${path}`);
    if (m === 'POST' && path === '/login') {
      const b = JSON.parse(init.body);
      return st.loginOk && b.password === password ? json(200, { token: 'jwt-1' }) : json(412, { code: 1011, message: 'Wrong username or password.' });
    }
    if (path === '/projects') {
      const t = st.tokens.find((x) => x.secret === auth);
      if (!t || Date.parse(t.expires_at) <= NOW) return json(401, { code: 11, message: 'invalid token' });
      if (st.refuseNewToken && t.id >= 10) return json(401, { code: 11, message: 'invalid token' });
      return json(200, [{ id: 1 }]);
    }
    if (auth !== 'jwt-1') return json(401, { message: 'login first' });
    if (m === 'GET' && path === '/tokens') return json(200, st.tokens.map(({ secret: _s, ...rest }) => rest));
    if (m === 'PUT' && path === '/tokens') {
      const b = JSON.parse(init.body); const id = st.nextId++;
      const t = { id, title: b.title, permissions: b.permissions, expires_at: b.expires_at, secret: `tk_new${id}` };
      st.tokens.push(t);
      return json(201, { id, title: t.title, permissions: t.permissions, expires_at: t.expires_at, token: t.secret });
    }
    if (m === 'DELETE' && path.startsWith('/tokens/')) {
      const id = Number(path.split('/')[2]); st.tokens = st.tokens.filter((t) => t.id !== id); return json(200, { message: 'deleted' });
    }
    return json(404, {});
  };
  return { st, fetchImpl };
}

const PERMS = { projects: ['read_all'], tasks: ['read_all', 'update'] };
let dir, settingsFile, config;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keeper-'));
  settingsFile = join(dir, 'admin-config.json');
  config = { vikunja: { url: 'http://vikunja:3456', token: 'tk_old' } };
  process.env.VIKUNJA_USERNAME = 'me';
  process.env.VIKUNJA_PASSWORD = 'pw';
  delete process.env.VIKUNJA_TOKEN;
});
const keeper = (fetchImpl) => new VikunjaTokenKeeper({ config, settingsFile, fetchImpl, now: () => NOW, log: quiet });
const oldToken = (daysLeft) => ({ id: 2, title: TITLE, permissions: PERMS, expires_at: new Date(NOW + daysLeft * DAY).toISOString(), secret: 'tk_old' });

test('a token far from expiry is kept; its expiry becomes known', async () => {
  const v = fakeVikunja({ tokens: [oldToken(200)] });
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.state, 'ok');
  assert.equal(s.daysLeft, 200);
  assert.equal(config.vikunja.token, 'tk_old');
  assert.ok(!v.st.calls.includes('PUT /tokens'), 'nothing made');
});

test('near expiry: a new token with the same permissions, saved, switched to live, the old one deleted', async () => {
  const v = fakeVikunja({ tokens: [oldToken(10)] });
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.state, 'ok');
  assert.equal(s.renewed, true);
  assert.equal(config.vikunja.token, 'tk_new10', 'the running gateway uses the new token');
  assert.equal(process.env.VIKUNJA_TOKEN, 'tk_new10');
  assert.equal(loadOverrides(settingsFile).VIKUNJA_TOKEN, 'tk_new10', 'saved for the next start');
  assert.equal((statSync(settingsFile).mode & 0o777).toString(8), '600');
  const made = v.st.tokens.find((t) => t.id === 10);
  assert.deepEqual(made.permissions, PERMS);
  assert.equal(made.title, TITLE);
  assert.equal(Math.round((Date.parse(made.expires_at) - NOW) / DAY), 365);
  assert.equal(v.st.tokens.some((t) => t.id === 2), false, 'old token deleted');
  assert.equal(s.daysLeft, 365);
  assert.doesNotMatch(JSON.stringify(s), /tk_/, 'status never carries a token');
  assert.doesNotMatch(readFileSync(join(dir, 'vikunja-token.json'), 'utf8'), /tk_/, 'the state file holds no token');
});

test('the next renewal uses the remembered id, even among other gateway tokens', async () => {
  const v = fakeVikunja({ tokens: [oldToken(10)] });
  const k = keeper(v.fetchImpl);
  await k.check();
  v.st.tokens.push({ id: 50, title: TITLE + ' (laptop)', permissions: PERMS, expires_at: new Date(NOW + 5 * DAY).toISOString(), secret: 'tk_other' });
  const s = await k.check();
  assert.equal(s.state, 'ok');
  assert.equal(s.renewed, undefined, 'its own token (id 10) is fresh: nothing renewed');
  assert.equal(config.vikunja.token, 'tk_new10');
});

test('a token Vikunja refuses is replaced (default permissions when there is nothing to copy)', async () => {
  const v = fakeVikunja({ tokens: [] });
  config.vikunja.token = 'tk_gone';
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.renewed, true);
  assert.equal(config.vikunja.token, 'tk_new10');
  assert.deepEqual(v.st.tokens[0].permissions, DEFAULT_PERMISSIONS);
});

test('a new token that does not work is thrown away and the old one kept', async () => {
  const v = fakeVikunja({ tokens: [oldToken(10)] });
  v.st.refuseNewToken = true;
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.state, 'expiring');
  assert.match(s.error, /did not work/);
  assert.equal(config.vikunja.token, 'tk_old');
  assert.equal(v.st.tokens.some((t) => t.id === 10), false, 'the broken new token was deleted');
  assert.equal(v.st.tokens.some((t) => t.id === 2), true, 'the old one is still there');
  assert.equal(loadOverrides(settingsFile).VIKUNJA_TOKEN, undefined);
});

test('without a login: only a health check, and it says how to turn renewal on', async () => {
  delete process.env.VIKUNJA_USERNAME;
  const v = fakeVikunja({ tokens: [oldToken(10)] });
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.state, 'ok');
  assert.equal(s.autoRenew, false);
  assert.match(s.note, /login/);
  assert.deepEqual(v.st.calls, ['GET /projects']);
});

test('a wrong saved login is reported and the working token is left alone', async () => {
  process.env.VIKUNJA_PASSWORD = 'wrong';
  const v = fakeVikunja({ tokens: [oldToken(10)] });
  const s = await keeper(v.fetchImpl).check();
  assert.equal(s.state, 'ok');
  assert.match(s.error, /login was refused/);
  assert.equal(config.vikunja.token, 'tk_old');
});

test('Renew now makes a new token even when far from expiry; checks running together share one run', async () => {
  const v = fakeVikunja({ tokens: [oldToken(300)] });
  const k = keeper(v.fetchImpl);
  const [a, b] = await Promise.all([k.check({ force: true }), k.check({ force: true })]);
  assert.equal(a.renewed, true);
  assert.deepEqual(a, b);
  assert.equal(v.st.calls.filter((c) => c === 'PUT /tokens').length, 1);
});

// ------------------------------------------------------------------ CalDAV sign-in with a gateway token

function listen(handler) { return new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); }); }
async function davRig({ creds = { username: 'me', password: 'vik pw' }, enabled = true } = {}) {
  const seen = [];
  const up = await listen((req, res) => { seen.push(req.headers.authorization); res.writeHead(207, { 'content-type': 'application/xml' }); res.end('<ok/>'); });
  const scopes = { alg_house: { kind: 'household' }, alg_person: { kind: 'person' } };
  const app = express();
  app.use(createCaldavProxy({
    target: `http://127.0.0.1:${up.address().port}`,
    tokenLogin: { enabled: () => enabled, isAdmin: (s) => s === 'admin-secret', resolve: (s) => (s === 'admin-secret' ? { kind: 'admin' } : scopes[s] ?? null), credentials: () => creds },
  }));
  const gw = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const dav = (user, pass) => fetch(`http://127.0.0.1:${gw.address().port}/dav/`, { method: 'PROPFIND', headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } });
  return { seen, dav, close: () => { up.close(); gw.close(); } };
}
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('CalDAV: a household or admin token signs in as the saved Vikunja login', async () => {
  const t = await davRig();
  try {
    assert.equal((await t.dav('orb', 'alg_house')).status, 207);
    assert.equal(t.seen.at(-1), basic('me', 'vik pw'));
    assert.equal((await t.dav('anything', 'admin-secret')).status, 207);
    assert.equal(t.seen.at(-1), basic('me', 'vik pw'));
  } finally { t.close(); }
});

test('CalDAV: person tokens and unknown alg_ tokens are refused and never reach Vikunja', async () => {
  const t = await davRig();
  try {
    const p = await t.dav('kid', 'alg_person');
    assert.equal(p.status, 403);
    assert.match(await p.text(), /person token/);
    const u = await t.dav('x', 'alg_revoked');
    assert.equal(u.status, 401);
    assert.match(u.headers.get('www-authenticate') ?? '', /Basic/);
    assert.equal(t.seen.length, 0);
  } finally { t.close(); }
});

test('CalDAV: an ordinary Vikunja password passes through untouched; off or no saved login behave as before / say what is missing', async () => {
  let t = await davRig();
  try {
    await t.dav('me', 'my own pw');
    assert.equal(t.seen.at(-1), basic('me', 'my own pw'));
  } finally { t.close(); }
  t = await davRig({ enabled: false });
  try {
    await t.dav('orb', 'alg_house');
    assert.equal(t.seen.at(-1), basic('orb', 'alg_house'), 'switched off: forwarded as is (Vikunja will refuse it)');
  } finally { t.close(); }
  t = await davRig({ creds: null });
  try {
    const r = await t.dav('orb', 'alg_house');
    assert.equal(r.status, 503);
    assert.match(await r.text(), /Vikunja login/);
  } finally { t.close(); }
});
