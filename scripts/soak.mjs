// Steady, modest load against a running AllGLANCE stack: by default ~500 requests
// over an hour, a realistic read/write mix, jittered pacing (not a stress test).
//
//   GATEWAY_URL=http://<host>:8090 GATEWAY_TOKEN=<token> node scripts/soak.mjs
//   SOAK_REQUESTS=60 SOAK_SECONDS=120 ...   for a quick check
//   SOAK_CONCURRENCY=3                      parallel workers (default 1)
//   SOAK_FULLSTACK=1 plus CALDAV_USER/CALDAV_PASSWORD, WEBDAV_USER/WEBDAV_PASSWORD, WEBDAV_URL:
//     also drives CalDAV (/dav), the WebDAV sync server, direct Vikunja and the app pages,
//     i.e. the whole stack, not only the MCP.
//
// It CREATES real tasks ("SOAK v n" in Vikunja, "SOAK dg n" in dayGLANCE) and marks
// some done; delete them afterwards. Prints a latency summary; the full log goes to
// SOAK_LOG (default ./soak-requests.jsonl). Watch container memory/CPU separately:
//   docker stats --no-stream
import { Client } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
const CONC = Math.max(1, Number(process.env.SOAK_CONCURRENCY ?? 1)); const FULL = process.env.SOAK_FULLSTACK === '1';
const DAVU = process.env.CALDAV_USER ?? '', DAVP = process.env.CALDAV_PASSWORD ?? '', WU = process.env.WEBDAV_USER ?? '', WP = process.env.WEBDAV_PASSWORD ?? '', WURL = (process.env.WEBDAV_URL ?? 'http://localhost:8091').replace(/\/$/, ''); const CALPROJ = process.env.CALDAV_PROJECT ?? '1';
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const OUT = process.argv[2] ?? process.env.SOAK_LOG ?? './soak-requests.jsonl'; const TOTAL = Number(process.env.SOAK_REQUESTS ?? 500); const SECS = Number(process.env.SOAK_SECONDS ?? 3600);
const BASE = (process.env.GATEWAY_URL ?? 'http://localhost:8090').replace(/\/$/, ''); const TOKEN = process.env.GATEWAY_TOKEN ?? '';
if (!TOKEN) console.warn('GATEWAY_TOKEN not set: assuming the gateway is open');
const rnd = (a, b) => a + Math.random() * (b - a); const pick = (a) => a[Math.floor(Math.random() * a.length)];
// One MCP client per worker: a worker reconnecting must never cut off another one's in-flight call.
const als = new AsyncLocalStorage(); const clients = new Map();
const connect = async (w) => { const old = clients.get(w)?.client; try { await old?.close(); } catch {} const c = new Client({ name: `soak-${w}`, version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} } })); clients.set(w, { client: c, calls: 0 }); return c; };
const day = (off) => new Date(Date.now() + off * 864e5).toLocaleDateString('en-CA');
const created = { vikunja: [], dayglance: [] }; let n = 0;
const log = (o) => appendFileSync(OUT, JSON.stringify(o) + '\n');
const tool = async (name, args) => { const w = als.getStore() ?? 0; let e = clients.get(w); if (!e || e.calls++ > 40) { await connect(w); e = clients.get(w); } const r = await e.client.callTool({ name, arguments: args }); const text = r.content?.[0]?.text ?? ''; if (r.isError) throw new Error(text.slice(0, 160)); return text; };
const rest = async (path, method = 'GET', body) => { const r = await fetch(BASE + path, { method, headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok && path !== '/health') throw new Error(`${r.status} ${t.slice(0, 120)}`); return t; };
const ACTIONS = [
  [25, 'get_day', () => tool('allglance_get_day', { date: day(Math.floor(rnd(-2, 14))) })],
  [14, 'list_tasks_open', () => tool('allglance_list_tasks', { limit: pick([10, 25, 50]) })],
  [6, 'list_tasks_filtered', () => tool('allglance_list_tasks', pick([{ source: 'vikunja', due_on_or_before: day(10) }, { source: 'dayglance' }, { status: 'done', limit: 20 }]))],
  [8, 'list_chores', () => tool('allglance_list_chores', { overdue_only: Math.random() < 0.5, limit: 10 })],
  [5, 'list_milestones', () => tool('allglance_list_milestones', {})],
  [4, 'list_users', () => tool('allglance_list_users', {})],
  [6, 'native_find_action', () => tool('vikunja_native_find_action', {})],
  [5, 'rest_tasks', () => rest('/api/allglance/tasks')],
  [3, 'rest_day', () => rest(`/api/allglance/days/${day(Math.floor(rnd(0, 7)))}`)],
  [2, 'health', () => rest('/health')],
  [12, 'create_vikunja', async () => { const t = await tool('allglance_create_task', { title: `SOAK v ${++n}`, due_date: day(Math.floor(rnd(1, 30))), priority: Math.floor(rnd(0, 6)) }); created.vikunja.push(JSON.parse(t).created.id); return t; }],
  [6, 'create_dayglance', async () => { const t = await tool('allglance_create_task', pick([{ title: `SOAK dg ${++n}`, source: 'dayglance', priority: 2 }, { title: `SOAK dg ${++n}`, source: 'dayglance', start: `${day(Math.floor(rnd(1, 20)))} ${pick(['09:00', '11:30', '14:00', '16:45'])}`, duration_minutes: 30 }])); created.dayglance.push(JSON.parse(t).created.id); return t; }],
  [4, 'update', async () => { const src = pick(['vikunja', 'dayglance']); const ids = created[src]; if (!ids.length) return tool('allglance_get_day', {}); const id = ids[Math.floor(Math.random() * ids.length)]; return tool('allglance_update_task', { source: src, id: String(id), done: true }); }],
];
let seq = 0; const mine = [];
const dav = async (method, path, { user = DAVU, pass = DAVP, base = BASE, body, headers = {}, ok = [200, 201, 204, 207, 404] } = {}) => { const r = await fetch(base + path, { method, headers: { Authorization: basic(user, pass), ...headers }, body }); const t = await r.text(); if (!ok.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}`); return t; };
const ics = (uid, summary) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//soak//EN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nDTSTAMP:20261106T000000Z\r\nSUMMARY:${summary}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
if (FULL) ACTIONS.push(
  [10, 'caldav_propfind', () => dav('PROPFIND', '/dav/projects', { headers: { Depth: '1', 'content-type': 'application/xml' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' })],
  [8, 'caldav_get_calendar', () => dav('GET', `/dav/projects/${CALPROJ}`)],
  [5, 'caldav_put_delete', async () => { const uid = `soak-${Date.now()}-${++seq}`; await dav('PUT', `/dav/projects/${CALPROJ}/${uid}.ics`, { headers: { 'content-type': 'text/calendar' }, body: ics(uid, `SOAK caldav ${seq}`) }); return dav('DELETE', `/dav/projects/${CALPROJ}/${uid}.ics`); }],
  [8, 'webdav_put_get', async () => { const n = `soak-${Date.now()}-${++seq}.json`; await dav('MKCOL', '/soak-test/', { user: WU, pass: WP, base: WURL, ok: [201, 405, 200] }); await dav('PUT', `/soak-test/${n}`, { user: WU, pass: WP, base: WURL, body: JSON.stringify({ n, pad: 'x'.repeat(4000) }), headers: { 'content-type': 'application/json' } }); mine.push(n); return dav('GET', `/soak-test/${n}`, { user: WU, pass: WP, base: WURL }); }],
  [4, 'webdav_propfind', () => dav('PROPFIND', '/', { user: WU, pass: WP, base: WURL, headers: { Depth: '1' } })],
  [3, 'app_pages', async () => { for (const u of ['http://localhost:6767/', 'http://localhost:3000/', 'http://localhost:6868/']) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} -> ${r.status}`); await r.text(); } }],
  [4, 'big_list', () => tool('allglance_list_tasks', { limit: 200 })],
);
const total = ACTIONS.reduce((s, a) => s + a[0], 0);
const chooseAction = () => { let r = Math.random() * total; for (const a of ACTIONS) { if ((r -= a[0]) < 0) return a; } return ACTIONS[0]; };
// CONC workers, each paced with jitter so that TOTAL requests fit into SECS overall.
const t0 = Date.now(); let ok = 0, fail = 0, issued = 0;
const meanGap = (SECS * CONC) / TOTAL;
async function worker(w) {
  while (issued < TOTAL) {
    await new Promise((r) => setTimeout(r, meanGap * rnd(0.6, 1.4) * 1000));
    if (issued >= TOTAL) break;
    const i = issued++; const [, name, fn] = chooseAction(); const s0 = Date.now();
    try { await als.run(w, fn); ok++; log({ i, w, t: Math.round((s0 - t0) / 1000), name, ms: Date.now() - s0, ok: true }); }
    catch (e) { fail++; log({ i, w, t: Math.round((s0 - t0) / 1000), name, ms: Date.now() - s0, ok: false, err: String(e.message).slice(0, 200) }); }
  }
}
await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));
if (FULL) for (const n of mine) { try { await dav('DELETE', `/soak-test/${n}`, { user: WU, pass: WP, base: WURL }); } catch {} }
if (FULL) { try { await dav('DELETE', '/soak-test/', { user: WU, pass: WP, base: WURL }); } catch {} }
writeFileSync(OUT + '.summary', JSON.stringify({ requests: issued, concurrency: CONC, ok, fail, elapsedSec: Math.round((Date.now() - t0) / 1000), created }));
for (const { client } of clients.values()) { try { await client.close(); } catch {} }
const lat = readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ms).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log('SOAK DONE', JSON.stringify({ ok, fail, elapsedSec: Math.round((Date.now() - t0) / 1000), p50_ms: q(0.5), p95_ms: q(0.95), max_ms: lat.at(-1) }));
process.exit(fail ? 1 : 0);
