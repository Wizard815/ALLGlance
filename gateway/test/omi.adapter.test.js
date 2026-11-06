// Omi (Wizard815/omi-local) surfaced through the gateway: its MCP tools as omi_* and its day
// summary inside allglance_get_day. A fake server stands in for Omi's /v1/mcp.
import { describe, it, before, after } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import http from 'node:http';
import { Roster } from '../src/identity/roster.js';
import { OmiAdapter } from '../src/adapters/OmiAdapter.js';
import { Gateway } from '../src/gateway.js';

const TOOLS = [
  { name: 'get_daily_summaries', description: 'Per-day summaries.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } } },
  { name: 'create_action_item', description: 'Write a task (Omi syncs these to Vikunja itself).', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_conversations', description: 'List conversations.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_screen_activity', description: 'Desktop screen activity.', inputSchema: { type: 'object', properties: {} } },
];
const SUMMARY = {
  daily_summaries: [{
    date: '2026-10-27', headline: 'A quiet Tuesday', overview: 'You had coffee.',
    highlights: [{ topic: 'Coffee', summary: 'Flat white' }], decisions_made: [{ decision: 'Switch beans' }],
    unresolved_questions: [{ question: 'Which grinder?' }], stats: { total_conversations: 2 },
  }],
};

function fakeOmi() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); return; }
      if (req.url !== '/v1/mcp') { res.statusCode = 404; res.end(); return; }
      if (req.headers.authorization !== 'Bearer omi_mcp_test') { res.statusCode = 401; res.end('{"detail":"bad key"}'); return; }
      const msg = JSON.parse(body || '{}');
      calls.push([msg.method, msg.params?.name, msg.params?.arguments]);
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      const result = msg.method === 'tools/list' ? { tools: TOOLS }
        : msg.method === 'tools/call' ? (msg.params.arguments?.start_date === '2026-10-28'
          ? { content: [{ type: 'text', text: JSON.stringify({ daily_summaries: [] }) }] }
          : { content: [{ type: 'text', text: JSON.stringify(SUMMARY) }] })
        : { capabilities: { tools: {} } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

const cfgFor = (url, extra = {}) => ({ omi: { enabled: true, url, token: 'omi_mcp_test', tools: 'core', ...extra } });

describe('omi adapter', () => {
  let fake;
  before(async () => { fake = await fakeOmi(); });
  after(() => fake.srv.close());

  it('is off without a URL', () => {
    const a = new OmiAdapter({ config: { omi: { enabled: true, url: '', token: '' } }, roster: new Roster() });
    equal(a.enabled, false);
  });

  it('exposes the core tools as omi_*, keeps their schemas, forwards calls with the key', async () => {
    const a = new OmiAdapter({ config: cfgFor(fake.url), roster: new Roster() });
    const tools = await a.dynamicTools();
    deepEqual(tools.map((t) => t.name), ['omi_get_daily_summaries', 'omi_get_conversations'], 'screen activity and action-item writes are not core tools');
    ok(tools[0].description.startsWith('[Omi:'));
    equal(tools[0].inputSchema.properties.start_date.type, 'string');
    const out = await tools[0].handler({ start_date: '2026-10-27', end_date: '2026-10-27' });
    equal(JSON.parse(out.content[0].text).daily_summaries[0].headline, 'A quiet Tuesday');
    ok(fake.calls.some(([m, name, args]) => m === 'tools/call' && name === 'get_daily_summaries' && args.start_date === '2026-10-27'));
  });

  it('OMI_TOOLS=all exposes everything, off exposes nothing', async () => {
    equal((await new OmiAdapter({ config: cfgFor(fake.url, { tools: 'all' }), roster: new Roster() }).dynamicTools()).length, 4);
    equal((await new OmiAdapter({ config: cfgFor(fake.url, { tools: 'off' }), roster: new Roster() }).dynamicTools()).length, 0);
  });

  it('reads the day summary, and null for a day Omi has no summary for', async () => {
    const a = new OmiAdapter({ config: cfgFor(fake.url), roster: new Roster() });
    const day = await a.daySummary('2026-10-27');
    equal(day.headline, 'A quiet Tuesday');
    deepEqual(day.highlights, ['Coffee']);
    deepEqual(day.decisions, ['Switch beans']);
    equal(day.conversations, 2);
    equal(await a.daySummary('2026-10-28'), null);
  });

  it('status reports health and the tool count; a dead Omi is not ok', async () => {
    const live = await new OmiAdapter({ config: cfgFor(fake.url), roster: new Roster() }).status();
    equal(live.ok, true); equal(live.mcpTools, 2);
    const dead = await new OmiAdapter({ config: cfgFor('http://127.0.0.1:9'), roster: new Roster() }).status();
    equal(dead.ok, false);
  });

  it('allglance_get_day carries omi_day_summary, and marks Omi unavailable when it cannot answer', async () => {
    const gw = new Gateway();
    gw.readBlocks = async () => [];
    gw.readTasksDetailed = async () => ({ by: { vikunja: [], dayglance: [] }, unavailable: [] });
    const omi = new OmiAdapter({ config: cfgFor(fake.url), roster: new Roster() });
    gw.adapter = (name) => (name === 'omi' ? omi : undefined);
    const day = await gw.getDay('2026-10-27');
    equal(day.omi_day_summary.headline, 'A quiet Tuesday');
    equal(day.unavailable, undefined);
    const empty = await gw.getDay('2026-10-28');
    equal(empty.omi_day_summary, null, 'a day Omi has no summary for is null, not an error');
    const dead = new OmiAdapter({ config: cfgFor('http://127.0.0.1:9'), roster: new Roster() });
    gw.adapter = (name) => (name === 'omi' ? dead : undefined);
    const broken = await gw.getDay('2026-10-27');
    deepEqual(broken.unavailable, ['omi']);
    equal(broken.omi_day_summary, null);
    // without Omi configured the field is absent, so existing clients see no change
    gw.adapter = () => undefined;
    equal('omi_day_summary' in (await gw.getDay('2026-10-27')), false);
  });
});
