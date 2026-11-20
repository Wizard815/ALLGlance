// Household and person tokens end to end: the real server (buildServer) over HTTP, in front of
// the stand-in Vikunja and dayGLANCE (scripts/dev/fake_*.py) and a stand-in Omi. Skipped when
// python3 is not installed.
import { describe, it, before, after } from 'node:test';
import { equal, ok, deepEqual, match } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { issueToken, revokeToken } from '../src/access.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEV = join(here, '..', '..', 'scripts', 'dev');
const hasPython = spawnSync('python3', ['--version']).status === 0;
// A day that is never today: the fake dayGLANCE reads "today" from the clock, and on that
// day its timed blocks are also today's scheduled tasks, so the list checks below would change.
const DAY = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function startFake(script, args) {
  const port = await freePort();
  const proc = spawn('python3', [join(DEV, script), '--port', String(port), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (/ on http/.test(String(d))) resolve(); });
    proc.on('exit', (code) => reject(new Error(`${script} exited ${code}`)));
  });
  return { proc, url: `http://127.0.0.1:${port}`, port };
}

function fakeOmi() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') return res.end('{"status":"ok"}');
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
      const result = msg.method === 'tools/list'
        ? { tools: [{ name: 'get_daily_summaries', description: 'Days.', inputSchema: { type: 'object', properties: {} } }, { name: 'get_conversations', description: 'Talk.', inputSchema: { type: 'object', properties: {} } }] }
        : msg.method === 'tools/call'
          ? { content: [{ type: 'text', text: JSON.stringify({ daily_summaries: [{ date: DAY, headline: 'Dana\'s day', overview: 'x' }] }) }] }
          : { capabilities: { tools: {} } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

describe('scoped tokens over HTTP', { skip: !hasPython && 'python3 is not installed' }, () => {
  let vikunja; let dayglance; let omi; let server; let base;
  const tok = {};
  const tokensFile = join(mkdtempSync(join(tmpdir(), 'alg-e2e-')), 'tokens.json');

  const req = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const mcp = async (token, name, args = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify(name === 'tools/list' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const msg = JSON.parse((await res.text()).split('\n').find((l) => l.startsWith('data:')).slice(5));
    if (name === 'tools/list') return msg.result.tools.map((t) => t.name);
    return msg.result.isError ? { error: msg.result.content[0].text } : JSON.parse(msg.result.content[0].text);
  };
  const vik = async (method, path, body) => {
    const res = await fetch(vikunja.url + path, { method, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };

  before(async () => {
    vikunja = await startFake('fake_vikunja.py', ['--token', 'tok']);
    dayglance = await startFake('fake_dayglance.py', ['--token', 'dg-tok']);
    omi = await fakeOmi();

    // Vikunja: one shared task, two private ones with owners, one private one with nobody.
    const make = async (title, labels, assignee) => {
      const t = await vik('POST', '/api/v2/projects/1/tasks', { title, due_date: `${DAY}T00:00:00Z`, labels });
      if (assignee) await vik('POST', `/api/v2/tasks/${t.id}/assignees`, { user_id: assignee });
      return t.id;
    };
    tok.binsId = await make('Bins out');
    tok.dentistId = await make('Dentist', [{ title: 'Private' }], 3);
    tok.partyId = await make('Surprise party', [{ title: 'private' }], 2);
    await make('Unowned secret', [{ title: 'private' }]);

    const sync = mkdtempSync(join(tmpdir(), 'alg-sync-'));
    mkdirSync(join(sync, 'lastglance'));
    writeFileSync(join(sync, 'lastglance', 'lastglance-sync.json'), JSON.stringify({ schemaVersion: 1, appId: 'lastglance', version: 1, data: { chores: [{ id: 'c1', name: 'Mop', assignedUserSyncIds: ['u-dana'], targetCadenceDays: 7 }], users: [] } }));

    Object.assign(config.server, { token: 'admin-tok' });
    Object.assign(config.access, { tokensFile, privateLabel: 'private', privateProjects: '', omiOwner: 'u-dana' });
    Object.assign(config.vikunja, { enabled: true, url: vikunja.url, token: 'tok', defaultProjectId: '', mcp: { enabled: false, token: '', tools: 'off' } });
    Object.assign(config.dayglance, { enabled: true, mcpHost: '127.0.0.1', mcpPort: dayglance.port, mcpToken: 'dg-tok' });
    Object.assign(config.lastglance, { enabled: true });
    Object.assign(config.lifeglance, { enabled: false });
    Object.assign(config.omi, { enabled: true, url: omi.url, token: 'omi_mcp_test', tools: 'core' });
    Object.assign(config.caldav, { proxy: false });
    Object.assign(config.sync, { dir: sync, passphrase: '', dayglanceFile: '' });
    process.env.DAYGLANCE_MCP_HOST = '127.0.0.1';

    tok.house = issueToken(tokensFile, { kind: 'household', name: 'kitchen' }).token;
    tok.sam = issueToken(tokensFile, { kind: 'person', name: 'sam', owner_id: '2', also: ['u-sam'] }).token;
    tok.dana = issueToken(tokensFile, { kind: 'person', name: 'dana', owner_id: 'u-dana', also: ['3'] }).token;
    tok.admin = 'admin-tok';

    const { buildServer } = await import('../src/server.js');
    const { app } = buildServer();
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;

    // dayGLANCE, through the gateway: one shared block, one of Dana's private ones, and a
    // private inbox task of Sam's (list reads see the inbox; blocks are read one day at a time).
    equal((await req('POST', '/api/allglance/tasks', tok.admin, { source: 'dayglance', title: 'Groceries', start: `${DAY} 09:00`, owner_id: 'u-sam' })).status, 201);
    equal((await req('POST', '/api/allglance/tasks', tok.admin, { source: 'dayglance', title: 'Therapy #private', start: `${DAY} 10:00`, owner_id: 'u-dana' })).status, 201);
    equal((await req('POST', '/api/allglance/tasks', tok.sam, { source: 'dayglance', title: 'Gift for Dana #private' })).status, 201, 'a person token assigns it to themselves');
  });

  after(() => {
    server?.close();
    omi?.srv.close();
    vikunja?.proc.kill();
    dayglance?.proc.kill();
  });

  it('a token is required; an unknown alg_ token is refused; /health stays open; the admin page wants GATEWAY_TOKEN', async () => {
    equal((await req('GET', '/api/allglance/tasks')).status, 401);
    equal((await req('GET', '/api/allglance/tasks', 'alg_unknown')).status, 401);
    equal((await req('GET', '/health')).status, 200);
    equal((await req('GET', '/admin/api/status', tok.house)).status, 401);
  });

  it('whoami answers each kind', async () => {
    deepEqual((await req('GET', '/api/allglance/whoami', tok.admin)).body, { scope: 'admin', owner_id: null, name: null, sees_private: 'all', omi: true });
    deepEqual((await req('GET', '/api/allglance/whoami', tok.house)).body, { scope: 'household', owner_id: null, name: 'kitchen', sees_private: 'none', omi: false });
    deepEqual((await req('GET', '/api/allglance/whoami', tok.sam)).body, { scope: 'person', owner_id: '2', also: ['u-sam'], name: 'sam', sees_private: 'own', omi: false });
    deepEqual(await mcp(tok.dana, 'allglance_whoami'), { scope: 'person', owner_id: 'u-dana', also: ['3'], name: 'dana', sees_private: 'own', omi: true });
  });

  it('lists: household gets no private items, a person gets only their own', async () => {
    const rest = async (t) => {
      const { body } = await req('GET', '/api/allglance/tasks', t);
      return [...body.vikunja, ...body.dayglance].map((x) => x.title).sort();
    };
    deepEqual(await rest(tok.admin), ['Bins out', 'Dentist', 'Gift for Dana #private', 'Surprise party', 'Unowned secret']);
    deepEqual(await rest(tok.house), ['Bins out']);
    deepEqual(await rest(tok.sam), ['Bins out', 'Gift for Dana #private', 'Surprise party']);
    deepEqual(await rest(tok.dana), ['Bins out', 'Dentist']);
    deepEqual((await mcp(tok.house, 'allglance_list_tasks', { status: 'all' })).tasks.map((t) => t.title), ['Bins out']);
    deepEqual((await mcp(tok.sam, 'allglance_list_tasks', { status: 'all' })).tasks.map((t) => t.title).sort(), ['Bins out', 'Gift for Dana #private', 'Surprise party']);
  });

  it('get_day: private blocks and Omi\'s summary only for whoever may see them', async () => {
    const day = (t) => mcp(t, 'allglance_get_day', { date: DAY });
    const house = await day(tok.house);
    deepEqual(house.blocks.map((b) => b.title), ['Groceries']);
    deepEqual(house.tasks.map((t) => t.title), ['Bins out']);
    equal('omi_day_summary' in house, false);
    const dana = await day(tok.dana);
    deepEqual(dana.blocks.map((b) => b.title), ['Groceries', 'Therapy #private']);
    equal(dana.omi_day_summary.headline, 'Dana\'s day');
    equal('omi_day_summary' in (await day(tok.sam)), false);
    const { body } = await req('GET', `/api/allglance/days/${DAY}`, tok.house);
    deepEqual(body.blocks.map((b) => b.title), ['Groceries']);
  });

  it('chores and the roster are for everyone; omi_* and the raw /vikunja routes are not', async () => {
    deepEqual((await mcp(tok.house, 'allglance_list_chores')).chores.map((c) => c.title), ['Mop']);
    ok((await mcp(tok.house, 'allglance_list_users')).users.length > 0);
    ok((await mcp(tok.dana, 'tools/list')).includes('omi_get_conversations'));
    equal((await mcp(tok.sam, 'tools/list')).some((n) => n.startsWith('omi_')), false);
    match((await mcp(tok.sam, 'omi_get_conversations')).error, /Omi wearable/);
    equal((await req('GET', '/api/allglance/vikunja/tasks', tok.house)).status, 403);
    equal((await req('GET', '/api/allglance/vikunja/tasks', tok.admin)).status, 200);
  });

  it('writes: a person creates for themselves; nobody else changes a private task', async () => {
    const created = await req('POST', '/api/allglance/tasks', tok.sam, { title: 'Call mum' });
    equal(created.status, 201);
    deepEqual((await vik('GET', `/api/v2/tasks/${created.body.task.id}`)).assignees.map((a) => a.id), [2]);
    equal((await req('PATCH', `/api/allglance/tasks/vikunja/${tok.dentistId}`, tok.house, { done: true })).status, 403);
    match((await mcp(tok.sam, 'allglance_update_task', { source: 'vikunja', id: String(tok.dentistId), done: true })).error, /someone else's private task/);
    equal((await vik('GET', `/api/v2/tasks/${tok.dentistId}`)).done, false, 'refused updates never reach Vikunja');
    equal((await req('PATCH', `/api/allglance/tasks/vikunja/${tok.dentistId}`, tok.dana, { done: true })).status, 200);
    equal((await vik('GET', `/api/v2/tasks/${tok.dentistId}`)).done, true);
    equal((await req('PATCH', `/api/allglance/tasks/vikunja/${tok.binsId}`, tok.house, { done: true })).status, 200);
  });

  it('a revoked token stops working on the next request', async () => {
    equal((await req('GET', '/api/allglance/whoami', tok.house)).status, 200);
    revokeToken(tokensFile, 'kitchen');
    const { utimesSync } = await import('node:fs');
    utimesSync(tokensFile, new Date(), new Date(Date.now() + 5000));
    equal((await req('GET', '/api/allglance/whoami', tok.house)).status, 401);
  });
});
