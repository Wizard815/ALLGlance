// Household and person tokens: the token file, the CLI, the request check, what counts as
// private, and what each kind of caller gets from every route and tool class.
import { describe, it, before, after } from 'node:test';
import { equal, ok, deepEqual, match, rejects, throws } from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMIN, TOKEN_PREFIX, issueToken, revokeToken, readTokens, TokenStore, authenticate, scopeOf,
  policyFrom, privateOwners, canSee, parsePrivateProjects,
} from '../src/access.js';
import { run as cli } from '../scripts/tokens.mjs';
import { Gateway } from '../src/gateway.js';
import { taskOf } from '../src/model.js';
import config from '../src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'alg-tokens-'));

describe('token file', () => {
  const file = join(dir, 'tokens.json');

  it('prints a token once and keeps only its hash, in a private file', () => {
    const { token, record } = issueToken(file, { kind: 'household', name: 'kitchen' });
    ok(token.startsWith(TOKEN_PREFIX) && token.length > 30);
    const text = readFileSync(file, 'utf8');
    equal(text.includes(token), false, 'the token itself is never stored');
    ok(text.includes(record.hash));
    equal((statSync(file).mode & 0o777).toString(8), '600');
    deepEqual(readTokens(file).map((t) => [t.name, t.kind, t.owner_id]), [['kitchen', 'household', null]]);
  });

  it('person tokens need an owner; names are unique and plain', () => {
    throws(() => issueToken(file, { kind: 'person', name: 'x' }), /needs the owner_id/);
    throws(() => issueToken(file, { kind: 'household', name: 'kitchen' }), /already exists/);
    throws(() => issueToken(file, { kind: 'household', name: 'has space' }), /short name/);
    throws(() => issueToken(file, { kind: 'admin', name: 'root' }), /household or person/);
    const { record } = issueToken(file, { kind: 'person', name: 'sam', owner_id: '2', also: ['u-sam', 'u-sam'] });
    deepEqual(record.also, ['u-sam']);
    deepEqual(scopeOf(record).ids, ['2', 'u-sam']);
  });

  it('the gateway sees new and revoked tokens without a restart; a broken file lets no scoped token in', () => {
    const f = join(dir, 'live.json');
    const store = new TokenStore(f);
    const { token } = issueToken(f, { kind: 'household', name: 'hall' });
    equal(store.lookup(token).name, 'hall');
    equal(store.lookup('alg_wrong'), null);
    equal(store.lookup('not-a-scoped-token'), null);
    equal(revokeToken(f, 'hall'), 1);
    utimesSync(f, new Date(), new Date(Date.now() + 5000)); // make sure the change is seen even within one mtime tick
    equal(store.lookup(token), null);
    equal(revokeToken(f, 'hall'), 0);
    const { token: t2 } = issueToken(f, { kind: 'household', name: 'hall2' });
    writeFileSync(f, '{broken');
    equal(store.lookup(t2), null);
  });
});

describe('scripts/tokens.mjs', () => {
  it('add-household, add-person, list, revoke', async () => {
    const file = join(dir, 'cli.json');
    const out = [];
    const log = (...a) => out.push(a.join(' '));
    const env = { ALLGLANCE_TOKENS_FILE: file, GATEWAY_TOKEN: 'x', GATEWAY_PORT: '1' };
    const h = await cli(['add-household', 'kitchen-tablet'], { env, log });
    ok(out.join('\n').includes(h.token), 'printed once');
    const p = await cli(['add-person', 'u-dana', 'dana-phone', '--also', '3'], { env, log });
    deepEqual([p.record.owner_id, p.record.also], ['u-dana', ['3']]);
    out.length = 0;
    const listed = await cli(['list'], { env, log });
    deepEqual(listed.map((t) => t.name), ['kitchen-tablet', 'dana-phone']);
    equal(out.join('\n').includes(TOKEN_PREFIX), false, 'list never shows a token');
    equal(JSON.stringify(listed).includes('hash'), false);
    await cli(['revoke', 'kitchen-tablet'], { env, log });
    await rejects(cli(['revoke', 'kitchen-tablet'], { env, log }), /no token named/);
    await rejects(cli(['add-person'], { env, log }), /give the owner_id/);
    out.length = 0;
    await cli(['add-household', 'den'], { env: { ALLGLANCE_TOKENS_FILE: file }, log });
    match(out.join('\n'), /only limit callers when the gateway has GATEWAY_TOKEN set/);
  });
});

describe('authenticate', () => {
  const file = join(dir, 'auth.json');
  const { token: house } = issueToken(file, { kind: 'household', name: 'h' });
  const { token: sam } = issueToken(file, { kind: 'person', name: 's', owner_id: '2' });
  const store = new TokenStore(file);
  const check = (mw, auth) => {
    let status = 200; let body; let scope;
    const req = { headers: auth ? { authorization: `Bearer ${auth}` } : {} };
    mw(req, { status: (c) => { status = c; return { json: (b) => { body = b; } }; } }, () => { scope = req.scope; });
    return { status, body, scope };
  };

  it('GATEWAY_TOKEN is admin, alg_ tokens get their scope, anything else is refused', () => {
    const mw = authenticate({ adminToken: 'admin-secret', store });
    equal(check(mw, 'admin-secret').scope, ADMIN);
    equal(check(mw, house).scope.kind, 'household');
    deepEqual([check(mw, sam).scope.kind, check(mw, sam).scope.owner_id], ['person', '2']);
    equal(check(mw, null).status, 401);
    equal(check(mw, 'admin-secreT').status, 401);
    const unknown = check(mw, 'alg_nope');
    equal(unknown.status, 401);
    match(unknown.body.error, /revoked, mistyped/);
  });

  it('without GATEWAY_TOKEN the gateway stays open (admin), but a bad alg_ token is still refused', () => {
    const mw = authenticate({ adminToken: '', store });
    equal(check(mw, null).scope, ADMIN);
    equal(check(mw, 'anything').scope, ADMIN);
    equal(check(mw, house).scope.kind, 'household');
    equal(check(mw, 'alg_nope').status, 401);
  });
});

describe('what counts as private', () => {
  const policy = policyFrom({ privateLabel: 'Private', privateProjects: '12:3, 14:u-sam', omiOwner: '' });
  const V = (extra) => taskOf('vikunja', { id: 1, title: 't', ...extra }, null);

  it('Vikunja: a "private" label (any case) or a private project; owners are every assignee plus the project owner', () => {
    equal(privateOwners(V({}), 'vikunja', policy), null);
    equal(privateOwners(V({ labels: [{ title: 'work' }] }), 'vikunja', policy), null);
    deepEqual([...privateOwners(V({ labels: [{ title: 'PRIVATE' }], assignees: [{ id: 2 }, { id: 3 }] }), 'vikunja', policy)].sort(), ['2', '3']);
    deepEqual([...privateOwners(V({ project_id: 12 }), 'vikunja', policy)], ['3']);
    deepEqual([...privateOwners(V({ labels: [{ title: 'private' }] }), 'vikunja', policy)], [], 'no owner: nobody but admin');
  });

  it('dayGLANCE: a #private tag in the title, not a longer tag', () => {
    const D = (title, ids) => taskOf('dayglance', { id: 'a', title, assignedUserSyncIds: ids }, ids?.[0] ?? null);
    deepEqual([...privateOwners(D('Therapy #private', ['u-dana']), 'dayglance', policy)], ['u-dana']);
    ok(privateOwners(D('Gift #Private #shopping', ['u-sam']), 'dayglance', policy));
    equal(privateOwners(D('Pirates #privateer'), 'dayglance', policy), null);
    equal(privateOwners(D('Private matters'), 'dayglance', policy), null, 'the word alone is not the tag');
    deepEqual([...privateOwners({ id: 'b', title: 'x #private', assignee_id: 'u-sam' }, 'dayglance', policy)], ['u-sam'], 'MCP blocks carry assignee_id');
  });

  it('lastGLANCE and lifeGLANCE carry no marker; a typo in VIKUNJA_PRIVATE_PROJECTS stops start-up', () => {
    equal(privateOwners({ title: 'Mop #private' }, 'lastglance', policy), null);
    equal(privateOwners({ title: 'Moved #private' }, 'lifeglance', policy), null);
    throws(() => parsePrivateProjects('12'), /should be <project id>:<owner id>/);
    deepEqual([...parsePrivateProjects('')], []);
  });

  it('canSee: admin all, household none of the private, person only their own', () => {
    const t = V({ labels: [{ title: 'private' }], assignees: [{ id: 2 }] });
    const sam = scopeOf({ kind: 'person', name: 's', owner_id: 'u-sam', also: ['2'] });
    const dana = scopeOf({ kind: 'person', name: 'd', owner_id: '3' });
    const house = scopeOf({ kind: 'household', name: 'h' });
    deepEqual([ADMIN, house, sam, dana].map((s) => canSee(s, t, 'vikunja', policy)), [true, false, true, false]);
  });
});

/* ------------------------------------------------------------------ every kind x every surface */

const SAM = scopeOf({ kind: 'person', name: 'sam', owner_id: '2', also: ['u-sam'] });
const DANA = scopeOf({ kind: 'person', name: 'dana', owner_id: 'u-dana', also: ['3'] });
const HOUSE = scopeOf({ kind: 'household', name: 'kitchen' });
const KINDS = { admin: ADMIN, household: HOUSE, sam: SAM, dana: DANA };

const DAY = '2026-11-20';
const vik = (id, title, extra = {}) => taskOf('vikunja', { id, title, due_date: DAY, ...extra }, extra.assignees?.[0] ? String(extra.assignees[0].id) : null);
const dg = (id, title, ids = []) => taskOf('dayglance', { id, title, date: DAY, assignedUserSyncIds: ids }, ids[0] ?? null);
const VIKUNJA = [
  vik(1, 'Bins out'),
  vik(2, 'Plan surprise party', { labels: [{ title: 'private' }], assignees: [{ id: 2 }] }),
  vik(3, 'Dentist', { labels: [{ title: 'Private' }], assignees: [{ id: 3 }] }),
  vik(4, 'Unowned secret', { labels: [{ title: 'private' }] }),
  vik(5, 'Journal', { project_id: 12 }),
];
const DAYGLANCE = [
  dg('d1', 'Groceries', ['u-sam']),
  dg('d2', 'Therapy #private', ['u-dana']),
  dg('d3', 'Gift for Dana #private', ['u-sam']),
  dg('d4', 'Pirates #privateer'),
];
const BLOCKS = [
  { id: 'd1', type: 'task', title: 'Groceries', date: DAY, start_time: '09:00', owner_id: 'u-sam' },
  { id: 'd2', type: 'task', title: 'Therapy #private', date: DAY, start_time: '10:00', owner_id: 'u-dana', assignedUserSyncIds: ['u-dana'] },
];
const SEES = {
  admin: ['Bins out', 'Dentist', 'Gift for Dana #private', 'Groceries', 'Journal', 'Pirates #privateer', 'Plan surprise party', 'Therapy #private', 'Unowned secret'],
  household: ['Bins out', 'Groceries', 'Pirates #privateer'],
  sam: ['Bins out', 'Gift for Dana #private', 'Groceries', 'Pirates #privateer', 'Plan surprise party'],
  dana: ['Bins out', 'Dentist', 'Groceries', 'Journal', 'Pirates #privateer', 'Therapy #private'],
};
const NATIVE = [{ name: 'vikunja_native_do_action', description: 'x', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ content: [{ type: 'text', text: '"native"' }] }) }];
const OMI = [{ name: 'omi_get_conversations', description: 'x', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ content: [{ type: 'text', text: '"omi"' }] }) }];

function household({ omiOwner = 'u-dana' } = {}) {
  const saved = config.omi.url;
  config.omi.url = 'http://127.0.0.1:9'; // turns the Omi adapter on; its calls are stubbed below
  let gw;
  try { gw = new Gateway(); } finally { config.omi.url = saved; }
  gw.policy = policyFrom({ privateLabel: 'private', privateProjects: '12:3', omiOwner });
  const writes = [];
  for (const a of gw.adapters()) {
    a.readTasks = async () => ({ tasks: a.source === 'vikunja' ? VIKUNJA : a.source === 'dayglance' ? DAYGLANCE : [] });
    a.writeTask = async (d) => { writes.push({ source: a.source, ...d }); return taskOf(a.source, { id: 99, title: d.title }, d.owner_id ?? null); };
    if (a.updateTask) a.updateTask = async (id, p) => { writes.push({ source: a.source, id, ...p }); return taskOf(a.source, { id, title: 'x' }, null); };
    if (a.source === 'vikunja') {
      a.readTask = async (id) => VIKUNJA.find((t) => t.id === String(id)) ?? null;
      a.dynamicTools = async () => NATIVE;
    }
    if (a.source === 'dayglance') a.readBlocks = async () => ({ blocks: BLOCKS });
    if (a.source === 'lastglance') a.readChores = async () => ({ chores: [{ source: 'lastglance', id: 'c1', title: 'Mop', owner_id: 'u-dana', overdue: true }] });
    if (a.source === 'lifeglance') a.readMilestones = async () => ({ milestones: [{ source: 'lifeglance', id: 'm1', title: 'Moved house', date: '2020-01-01', owner_id: null }] });
    if (a.source === 'omi') {
      a.dynamicTools = async () => OMI;
      a.daySummary = async () => ({ source: 'daily_summary', headline: 'Dana\'s day' });
    }
  }
  return { gw, writes };
}
const tool = (gw, scope, name) => gw.registerMcpTools(scope).find((t) => t.name === name);
const call = async (gw, scope, name, args = {}) => JSON.parse((await tool(gw, scope, name).handler(args)).content[0].text);
const titles = (list) => list.map((t) => t.title).sort();

// The REST routes, invoked without a server: each route's handler chain runs with req.scope set.
function routes(gw) {
  const table = [];
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (path, ...handlers) => table.push({ m, path, handlers });
  gw.registerRoutes(app, '/api/allglance');
  return async (m, path, { scope = ADMIN, params = {}, query = {}, body = {} } = {}) => {
    const r = table.find((x) => x.m === m && x.path === path);
    if (!r) throw new Error(`no route ${m} ${path}`);
    let status = 200; let payload;
    const req = { scope, params, query, body, path };
    const res = { status: (c) => { status = c; return res; }, json: (b) => { payload = b; return res; } };
    for (const h of r.handlers) {
      let goOn = false;
      await h(req, res, () => { goOn = true; });
      if (!goOn) break;
    }
    return { status, payload };
  };
}

describe('every kind of token, every surface', () => {
  for (const [kind, scope] of Object.entries(KINDS)) {
    it(`${kind}: list_tasks and GET /tasks show exactly what it may see`, async () => {
      const { gw } = household();
      deepEqual(titles((await call(gw, scope, 'allglance_list_tasks', { status: 'all' })).tasks), SEES[kind]);
      const { payload } = await routes(gw)('get', '/api/allglance/tasks', { scope });
      deepEqual(titles([...payload.vikunja, ...payload.dayglance]), SEES[kind]);
    });

    it(`${kind}: get_day and GET /days/:date leave out private blocks and tasks it may not see`, async () => {
      const { gw } = household();
      const d = await call(gw, scope, 'allglance_get_day', { date: DAY });
      const blocks = d.blocks.map((b) => b.title);
      equal(blocks.includes('Therapy #private'), kind === 'admin' || kind === 'dana');
      ok(blocks.includes('Groceries'));
      for (const t of d.tasks) ok(SEES[kind].includes(t.title), `${kind} must not see ${t.title}`);
      const { payload } = await routes(gw)('get', '/api/allglance/days/:date', { scope, params: { date: DAY } });
      equal(payload.blocks.some((b) => b.title === 'Therapy #private'), kind === 'admin' || kind === 'dana');
      for (const t of Object.values(payload.tasks).flat()) ok(SEES[kind].includes(t.title));
    });

    it(`${kind}: chores, milestones and the roster are household data`, async () => {
      const { gw } = household();
      deepEqual((await call(gw, scope, 'allglance_list_chores')).chores.map((c) => c.title), ['Mop']);
      deepEqual((await call(gw, scope, 'allglance_list_milestones')).milestones.map((m) => m.title), ['Moved house']);
      ok(Array.isArray((await call(gw, scope, 'allglance_list_users')).users));
      const r = routes(gw);
      equal((await r('get', '/api/allglance/chores', { scope })).payload.chores.length, 1);
      equal((await r('get', '/api/allglance/milestones', { scope })).payload.milestones.length, 1);
      equal((await r('get', '/api/allglance/users', { scope })).status, 200);
    });
  }

  it('whoami, over MCP and REST, says the scope', async () => {
    const { gw } = household();
    deepEqual(await call(gw, ADMIN, 'allglance_whoami'), { scope: 'admin', owner_id: null, name: null, sees_private: 'all', omi: true });
    deepEqual(await call(gw, HOUSE, 'allglance_whoami'), { scope: 'household', owner_id: null, name: 'kitchen', sees_private: 'none', omi: false });
    deepEqual((await routes(gw)('get', '/api/allglance/whoami', { scope: SAM })).payload, { scope: 'person', owner_id: '2', also: ['u-sam'], name: 'sam', sees_private: 'own', omi: false });
    equal((await call(gw, DANA, 'allglance_whoami')).omi, true, 'Dana wears the Omi');
    await rejects(tool(gw, SAM, 'allglance_whoami').handler({ owner_id: '3' }), /takes no arguments/);
  });

  it('Omi: its tools and its day summary only for admin and the Omi owner; never without OMI_OWNER_ID', async () => {
    const { gw } = household();
    const names = async (scope) => (await gw.dynamicMcpTools(scope)).map((t) => t.name);
    deepEqual(await names(ADMIN), ['vikunja_native_do_action', 'omi_get_conversations']);
    deepEqual(await names(DANA), ['omi_get_conversations']);
    deepEqual(await names(SAM), []);
    deepEqual(await names(HOUSE), []);
    equal((await call(gw, DANA, 'allglance_get_day', { date: DAY })).omi_day_summary.headline, 'Dana\'s day');
    equal('omi_day_summary' in (await call(gw, SAM, 'allglance_get_day', { date: DAY })), false);
    equal('omi_day_summary' in (await call(gw, HOUSE, 'allglance_get_day', { date: DAY })), false);
    match(gw.toolRefusal('omi_get_conversations', SAM), /u-dana's person token/);
    const unowned = household({ omiOwner: '' }).gw;
    deepEqual((await unowned.dynamicMcpTools(DANA)).map((t) => t.name), []);
    match(unowned.toolRefusal('omi_get_conversations', DANA), /OMI_OWNER_ID is not set/);
  });

  it('vikunja_native_* and the raw /vikunja/* routes are admin-only', async () => {
    const { gw } = household();
    for (const s of [HOUSE, SAM, DANA]) match(gw.toolRefusal('vikunja_native_do_action', s), /only the admin token/);
    equal(gw.toolRefusal('vikunja_native_do_action', ADMIN), null);
    const r = routes(gw);
    for (const s of [HOUSE, SAM]) {
      const { status, payload } = await r('get', '/api/allglance/vikunja/tasks', { scope: s });
      equal(status, 403);
      match(payload.error, /only the admin token/);
    }
    equal((await r('get', '/api/allglance/vikunja/tasks', { scope: SAM })).payload.tasks, undefined);
  });
});

describe('writes', () => {
  it('a person token creates tasks for itself, under the id each app knows it by; others may name anyone', async () => {
    const { gw, writes } = household();
    await call(gw, SAM, 'allglance_create_task', { title: 'Call mum' });
    await call(gw, SAM, 'allglance_create_task', { title: 'Walk', source: 'dayglance', start: `${DAY} 08:00` });
    await call(gw, SAM, 'allglance_create_task', { title: 'For Dana', owner_id: '3' });
    await call(gw, HOUSE, 'allglance_create_task', { title: 'Shared' });
    await call(gw, HOUSE, 'allglance_create_task', { title: 'For Sam', owner_id: '2' });
    const r = await routes(gw)('post', '/api/allglance/tasks', { scope: DANA, body: { title: 'REST', source: 'dayglance' } });
    equal(r.status, 201);
    deepEqual(writes.map((w) => [w.title, w.source, w.owner_id]), [
      ['Call mum', 'vikunja', '2'], ['Walk', 'dayglance', 'u-sam'], ['For Dana', 'vikunja', '3'],
      ['Shared', 'vikunja', undefined], ['For Sam', 'vikunja', '2'], ['REST', 'dayglance', 'u-dana'],
    ]);
  });

  it('nobody but admin and the owner can change a private task; non-private ones are open to every token', async () => {
    const { gw, writes } = household();
    const update = (scope, args) => tool(gw, scope, 'allglance_update_task').handler(args);
    await rejects(update(HOUSE, { source: 'vikunja', id: '3', done: true }), /someone else's private task.*Nothing was changed/);
    await rejects(update(SAM, { source: 'vikunja', id: '3', done: true }), /someone else's private task/);
    await rejects(update(SAM, { source: 'dayglance', id: 'd2', done: true }), /someone else's private task/);
    await rejects(update(DANA, { source: 'vikunja', id: '4', title: 'mine now' }), /someone else's private task/);
    await rejects(update(HOUSE, { source: 'dayglance', id: 'nope', done: true }), /Could not find dayglance task nope/);
    const r = routes(gw);
    const refused = await r('patch', '/api/allglance/tasks/:source/:id', { scope: HOUSE, params: { source: 'dayglance', id: 'd3' }, body: { done: true } });
    equal(refused.status, 403);
    equal(writes.length, 0, 'no refused update reached an app');
    await update(DANA, { source: 'vikunja', id: '3', done: true });
    await update(DANA, { source: 'vikunja', id: '5', done: true });
    await update(SAM, { source: 'dayglance', id: 'd3', title: 'Gift #private' });
    await update(HOUSE, { source: 'vikunja', id: '1', done: true });
    await update(HOUSE, { source: 'dayglance', id: 'd1', done: true });
    await update(ADMIN, { source: 'vikunja', id: '4', done: true });
    equal((await r('patch', '/api/allglance/tasks/:source/:id', { scope: SAM, params: { source: 'vikunja', id: '1' }, body: { priority: 3 } })).status, 200);
    deepEqual(writes.map((w) => `${w.source}:${w.id}`), ['vikunja:3', 'vikunja:5', 'dayglance:d3', 'vikunja:1', 'dayglance:d1', 'vikunja:4', 'vikunja:1']);
  });

  it('a project-name typo does not list private project names to a scoped token', async () => {
    const { gw } = household();
    gw.adapter('vikunja').writeTask = async () => { throw new Error('No Vikunja project named "Nope". Projects: Inbox, Dana divorce'); };
    await rejects(gw.as(HOUSE).createTask({ title: 'x', project: 'Nope' }), (err) => !/divorce/.test(err.message) && /No Vikunja project named "Nope"\.$/.test(err.message));
    await rejects(gw.as(ADMIN).createTask({ title: 'x', project: 'Nope' }), /Dana divorce/);
  });
});

describe('the MCP endpoint refuses by name', () => {
  let srv; let url;
  before(async () => {
    const express = (await import('express')).default;
    const { createMcpRouter } = await import('../src/mcp/server.js');
    const { gw } = household();
    const app = express();
    app.use('/mcp', (req, _res, next) => { req.scope = req.headers['x-test-scope'] === 'household' ? HOUSE : ADMIN; next(); });
    app.use(createMcpRouter(gw));
    srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    url = `http://127.0.0.1:${srv.address().port}/mcp`;
  });
  after(() => srv.close());

  const rpc = async (scope, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-test-scope': scope }, body: JSON.stringify(body) });
    return JSON.parse((await res.text()).split('\n').find((l) => l.startsWith('data:')).slice(5));
  };

  it('tools/list hides what the scope cannot use, and calling it anyway says why', async () => {
    const list = async (scope) => (await rpc(scope, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    ok((await list('admin')).includes('vikunja_native_do_action'));
    const house = await list('household');
    ok(house.includes('allglance_whoami') && house.includes('allglance_list_tasks'));
    equal(house.some((n) => n.startsWith('vikunja_native_') || n.startsWith('omi_')), false);
    const r = await rpc('household', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'omi_get_conversations', arguments: {} } });
    equal(r.result.isError, true);
    match(r.result.content[0].text, /reads one person's Omi wearable/);
    const who = await rpc('household', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'allglance_whoami', arguments: {} } });
    equal(JSON.parse(who.result.content[0].text).scope, 'household');
  });
});
