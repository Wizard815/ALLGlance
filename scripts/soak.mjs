// Steady, modest load against a running AllGLANCE stack: by default ~500 requests
// over an hour, a realistic read/write mix, jittered pacing (not a stress test).
//
//   GATEWAY_URL=http://<host>:8090 GATEWAY_TOKEN=<token> node scripts/soak.mjs
//   SOAK_REQUESTS=60 SOAK_SECONDS=120 ...   for a quick check
//
// It CREATES real tasks ("SOAK v n" in Vikunja, "SOAK dg n" in dayGLANCE) and marks
// some done; delete them afterwards. Prints a latency summary; the full log goes to
// SOAK_LOG (default ./soak-requests.jsonl). Watch container memory/CPU separately:
//   docker stats --no-stream
import { Client } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
const OUT = process.argv[2] ?? process.env.SOAK_LOG ?? './soak-requests.jsonl'; const TOTAL = Number(process.env.SOAK_REQUESTS ?? 500); const SECS = Number(process.env.SOAK_SECONDS ?? 3600);
const BASE = (process.env.GATEWAY_URL ?? 'http://localhost:8090').replace(/\/$/, ''); const TOKEN = process.env.GATEWAY_TOKEN ?? '';
if (!TOKEN) console.warn('GATEWAY_TOKEN not set: assuming the gateway is open');
const rnd = (a, b) => a + Math.random() * (b - a); const pick = (a) => a[Math.floor(Math.random() * a.length)];
let client = null, calls = 0;
const connect = async () => { try { await client?.close(); } catch {} client = new Client({ name: 'soak', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} } })); calls = 0; };
const day = (off) => new Date(Date.now() + off * 864e5).toLocaleDateString('en-CA');
const created = { vikunja: [], dayglance: [] }; let n = 0;
const log = (o) => appendFileSync(OUT, JSON.stringify(o) + '\n');
const tool = async (name, args) => { if (!client || calls++ > 40) await connect(); const r = await client.callTool({ name, arguments: args }); const text = r.content?.[0]?.text ?? ''; if (r.isError) throw new Error(text.slice(0, 160)); return text; };
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
const total = ACTIONS.reduce((s, a) => s + a[0], 0);
const chooseAction = () => { let r = Math.random() * total; for (const a of ACTIONS) { if ((r -= a[0]) < 0) return a; } return ACTIONS[0]; };
// Jittered schedule that fits TOTAL requests into SECS.
let gaps = Array.from({ length: TOTAL }, () => rnd(0.6, 1.4)); const k = SECS / gaps.reduce((a, b) => a + b, 0); gaps = gaps.map((g) => g * k);
const t0 = Date.now(); let ok = 0, fail = 0;
for (let i = 0; i < TOTAL; i++) {
  await new Promise((r) => setTimeout(r, gaps[i] * 1000));
  const [, name, fn] = chooseAction(); const s = Date.now();
  try { await fn(); ok++; log({ i, t: Math.round((s - t0) / 1000), name, ms: Date.now() - s, ok: true }); }
  catch (e) { fail++; log({ i, t: Math.round((s - t0) / 1000), name, ms: Date.now() - s, ok: false, err: String(e.message).slice(0, 200) }); }
}
writeFileSync(OUT + '.summary', JSON.stringify({ requests: TOTAL, ok, fail, elapsedSec: Math.round((Date.now() - t0) / 1000), created }));
try { await client?.close(); } catch {}
const lat = readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ms).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log('SOAK DONE', JSON.stringify({ ok, fail, elapsedSec: Math.round((Date.now() - t0) / 1000), p50_ms: q(0.5), p95_ms: q(0.95), max_ms: lat.at(-1) }));
process.exit(fail ? 1 : 0);
