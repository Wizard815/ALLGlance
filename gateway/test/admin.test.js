// The admin page: saved settings (validation, precedence, secrets) and its API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalise, SETTINGS, loadOverrides, saveOverrides, applyOverrides, describe } from '../src/adminSettings.js';
import { createAdminRouter } from '../src/admin.js';
import { requireToken } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'admin-'));
const file = join(dir, 'admin-config.json');
const by = (k) => SETTINGS.find((s) => s.key === k);

test('normalise: bools, enums, ints, urls, secrets', () => {
  assert.equal(normalise(by('ENABLE_OMI'), 'ON'), 'true');
  assert.equal(normalise(by('ENABLE_OMI'), 'no'), 'false');
  assert.equal(normalise(by('ENABLE_OMI'), ''), '');
  assert.throws(() => normalise(by('ENABLE_OMI'), 'maybe'), /on or off/);
  assert.equal(normalise(by('OMI_TOOLS'), 'all'), 'all');
  assert.throws(() => normalise(by('OMI_TOOLS'), 'everything'), /core, all, off/);
  assert.equal(normalise(by('VIKUNJA_DEFAULT_PROJECT_ID'), '12'), '12');
  assert.throws(() => normalise(by('VIKUNJA_DEFAULT_PROJECT_ID'), '1; drop'), /whole number/);
  assert.equal(normalise(by('OMI_URL'), 'http://192.168.1.20:8000/'), 'http://192.168.1.20:8000');
  assert.throws(() => normalise(by('OMI_URL'), 'javascript:alert(1)'), /full address/);
  assert.throws(() => normalise(by('OMI_URL'), '192.168.1.20'), /full address/);
  assert.throws(() => normalise(by('OMI_MCP_TOKEN'), 'has space'), /no spaces/);
});

test('save, load, clear; unknown keys refused; nothing written on a bad value; file is private', () => {
  assert.deepEqual(saveOverrides(file, { OMI_URL: 'http://10.0.0.5:8000', OMI_TOOLS: 'all' }).sort(), ['OMI_TOOLS', 'OMI_URL']);
  assert.deepEqual(loadOverrides(file), { OMI_URL: 'http://10.0.0.5:8000', OMI_TOOLS: 'all' });
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(saveOverrides(file, { OMI_TOOLS: 'all' }), [], 'same value: no change');
  assert.throws(() => saveOverrides(file, { OMI_TOOLS: 'core', OMI_URL: 'nope' }), /full address/);
  assert.equal(loadOverrides(file).OMI_TOOLS, 'all', 'a bad value in the batch wrote nothing');
  assert.throws(() => saveOverrides(file, { GATEWAY_TOKEN: 'x' }), /cannot be changed/);
  assert.deepEqual(saveOverrides(file, { OMI_TOOLS: '' }), ['OMI_TOOLS']);
  assert.deepEqual(loadOverrides(file), { OMI_URL: 'http://10.0.0.5:8000' });
});

test('saved values win over the environment; a hand-edited file cannot inject other variables', () => {
  writeFileSync(file, JSON.stringify({ OMI_URL: 'http://10.0.0.5:8000', GATEWAY_TOKEN: 'evil', PATH: '/x' }));
  const env = { OMI_URL: 'http://old:1', GATEWAY_TOKEN: 'real' };
  applyOverrides(file, env);
  assert.equal(env.OMI_URL, 'http://10.0.0.5:8000');
  assert.equal(env.GATEWAY_TOKEN, 'real');
  assert.equal(env.PATH, undefined);
  assert.deepEqual(applyOverrides(join(dir, 'missing.json'), {}), {}, 'no file is fine');
});

test('describe never returns a secret, only whether it is set', () => {
  const d = describe(file, { OMI_MCP_TOKEN: 'omi_mcp_secret', OMI_URL: 'http://10.0.0.5:8000' });
  const tok = d.find((s) => s.key === 'OMI_MCP_TOKEN');
  assert.equal(tok.set, true); assert.equal('value' in tok, false);
  assert.equal(JSON.stringify(d).includes('omi_mcp_secret'), false);
  assert.equal(d.find((s) => s.key === 'OMI_URL').source, 'admin');
  assert.equal(d.find((s) => s.key === 'ENABLE_OMI').value, 'true', 'defaults are shown');
});

// ---- the router ----
let server; let base; let restarts = 0;
const fakeGateway = {
  adapters: () => [
    { source: 'vikunja', status: async () => ({ ok: true, authenticated: true }) },
    { source: 'dayglance', status: async () => ({ ok: true, mode: 'mcp' }) },
    { source: 'lastglance', status: async () => ({ ok: false, error: 'no lastglance-sync.json yet' }) },
    { source: 'omi', status: () => new Promise(() => {}) }, // never answers
  ],
  roster: { list: () => [{ id: '1', name: 'Sam', source: 'dayglance' }] },
  adapter: (n) => (n === 'omi' ? { status: async () => ({ ok: false, error: 'fetch failed' }) } : undefined),
};
function boot({ token, supervised }) {
  const config = { server: { token, port: 8090 }, sync: { dir: dir, passphrase: 'pp', dayglanceFile: '' }, vikunja: { url: 'http://vikunja:3456' }, omi: { url: '' } };
  const app = express();
  app.use(createAdminRouter({ gateway: fakeGateway, config, settingsFile: join(dir, 'cfg.json'), guard: token ? requireToken(token) : undefined, supervised, restart: () => { restarts++; } }));
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}
const get = (path, token) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => { process.env.DAYGLANCE_SYNC_PASSWORD = 'syncpw'; server = await boot({ token: 'tok123', supervised: true }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test('the page is served; the API wants the token', async () => {
  const page = await get('/admin');
  assert.equal(page.status, 200); assert.match(await page.text(), /AllGLANCE admin/);
  assert.equal((await get('/admin/api/status')).status, 401);
  assert.equal((await get('/admin/api/status', 'wrong')).status, 401);
  assert.equal((await get('/admin/api/status', 'tok123')).status, 200);
});

test('status reports each app, sync files and the handoff folder', async () => {
  writeFileSync(join(dir, 'lastglance-sync.json'), '{"v":1,"enc":"AES-GCM-256","data":"x"}');
  const s = await (await get('/admin/api/status', 'tok123')).json();
  assert.equal(s.adapters.dayglance.mode, 'mcp'); assert.equal(s.adapters.lastglance.ok, false);
  assert.equal(s.files.lastglance.exists, true); assert.equal(s.files.lastglance.encrypted, true);
  assert.equal(s.files.lifeglance.exists, false); assert.equal(s.supervised, true);
  assert.equal(s.roster[0].name, 'Sam');
  assert.equal(s.adapters.omi.ok, false); assert.match(s.adapters.omi.error, /in time/, 'a dead app is reported, not waited for forever');
});

test('setup: values derived from the request host, a checklist, and secrets only with a token', async () => {
  const s = await (await fetch(base + '/admin/api/setup', { headers: { authorization: 'Bearer tok123', 'x-forwarded-host': 'nas.lan:8090' } })).json();
  assert.equal(s.connect.mcpUrl, 'http://nas.lan:8090/mcp');
  assert.equal(s.connect.syncUrl, 'http://nas.lan:8091');
  assert.equal(s.connect.caldavUrl, 'http://nas.lan:8090/dav/');
  assert.equal(s.connect.token, 'tok123'); assert.equal(s.connect.syncPassword, 'syncpw');
  assert.match(s.snippets.omiHost, /ALLGLANCE_URL=http:\/\/nas.lan:8090/);
  assert.equal(s.checklist.find((c) => c.id === 'lastglance').ok, false);
  assert.equal(s.checklist.find((c) => c.id === 'vikunja').ok, true);
  // no token configured: the page works but shows no secrets
  const open = await boot({ token: '', supervised: false });
  const o = await (await fetch(`http://127.0.0.1:${open.address().port}/admin/api/setup`)).json();
  open.close();
  assert.equal(o.connect.token, null); assert.equal(o.connect.syncPassword, null);
  assert.equal(JSON.stringify(o).includes('syncpw'), false);
  assert.equal(o.checklist.find((c) => c.id === 'token').ok, false);
});

test('config: save returns what changed; secrets stay write-only; bad input is a 400', async () => {
  const put = (body) => fetch(base + '/admin/api/config', { method: 'PUT', headers: { authorization: 'Bearer tok123', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r = await put({ OMI_URL: 'http://10.1.1.1:8000', OMI_MCP_TOKEN: 'omi_mcp_abc', ENABLE_LASTGLANCE: 'false' });
  assert.deepEqual((await r.json()).changed.sort(), ['ENABLE_LASTGLANCE', 'OMI_MCP_TOKEN', 'OMI_URL']);
  const cfg = await (await get('/admin/api/config', 'tok123')).json();
  assert.equal(JSON.stringify(cfg).includes('omi_mcp_abc'), false);
  assert.equal(cfg.settings.find((s) => s.key === 'OMI_MCP_TOKEN').source, 'admin');
  assert.equal(readFileSync(join(dir, 'cfg.json'), 'utf8').includes('omi_mcp_abc'), true, 'stored on the data volume, not returned');
  r = await put({ OMI_TOOLS: 'null' }); assert.equal(r.status, 400);
  r = await put({ GATEWAY_TOKEN: 'x' }); assert.equal(r.status, 400);
  r = await put({ OMI_MCP_TOKEN: null }); assert.deepEqual((await r.json()).changed, [], 'an untouched secret is left alone');
});

test('restart only under the supervisor; test endpoint reports a dead app', async () => {
  const post = (path, b) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer tok123' }, body: b });
  assert.equal((await post('/admin/api/restart')).status, 202);
  await new Promise((r) => setTimeout(r, 450)); assert.equal(restarts, 1);
  assert.equal((await post('/admin/api/test/omi')).status, 200);
  assert.equal((await post('/admin/api/test/nothing')).status, 404);
  const plain = await boot({ token: 'tok123', supervised: false });
  const r = await fetch(`http://127.0.0.1:${plain.address().port}/admin/api/restart`, { method: 'POST', headers: { authorization: 'Bearer tok123' } });
  plain.close();
  assert.equal(r.status, 409);
});
