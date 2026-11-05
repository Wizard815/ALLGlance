// Vikunja's built-in MCP (/api/v2/mcp) surfaced through the gateway as
// vikunja_native_* tools. A fake server stands in for Vikunja 2.7+.
import { describe, it, before, after } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import http from 'node:http';
import { Roster } from '../src/identity/roster.js';
import { VikunjaAdapter } from '../src/adapters/VikunjaAdapter.js';
import { Gateway } from '../src/gateway.js';
import config from '../src/config.js';

const TOOLS = [
  { name: 'tasks_list', description: 'List tasks across all projects.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'find_action', description: 'Discover additional actions.', inputSchema: { type: 'object', properties: { resource: { type: 'string' } } } },
];

function fakeVikunja({ allow = true } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') { res.end('OK'); return; }
      if (req.url.startsWith('/api/v2/projects')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: [], total_pages: 1 })); return; }
      if (req.url !== '/api/v2/mcp') { res.statusCode = 404; res.end(); return; }
      if (!allow || req.headers.authorization !== 'Bearer mcp-token') { res.statusCode = 403; res.end('{"message":"token does not have mcp:access scope"}'); return; }
      const msg = JSON.parse(body || '{}');
      calls.push(msg.method);
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      const result = msg.method === 'tools/list' ? { tools: TOOLS }
        : msg.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ echoed: msg.params }) }] }
        : { capabilities: { tools: {} } };
      res.setHeader('content-type', 'text/event-stream');
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

const cfgFor = (url, extra = {}) => ({
  vikunja: { enabled: true, url, token: 'mcp-token', mcp: { enabled: true, token: '', ...extra } },
  playwright: {}, sync: { dir: '' }, dayglance: {}, lastglance: {}, lifeglance: {},
});

describe('vikunja native MCP tools', () => {
  let fake;
  before(async () => { fake = await fakeVikunja(); });
  after(() => fake.srv.close());

  it('discovers native tools, prefixes them, keeps their schemas, and forwards calls', async () => {
    const a = new VikunjaAdapter({ config: cfgFor(fake.url), roster: new Roster() });
    const tools = await a.dynamicTools();
    deepEqual(tools.map((t) => t.name), ['vikunja_native_tasks_list', 'vikunja_native_find_action']);
    ok(tools[0].description.startsWith('[Vikunja native]'));
    equal(tools[0].inputSchema.properties.filter.type, 'string');
    const out = await tools[0].handler({ filter: 'done = false' });
    equal(JSON.parse(out.content[0].text).echoed.name, 'tasks_list');
    equal(JSON.parse(out.content[0].text).echoed.arguments.filter, 'done = false');
  });

  it('caches discovery (one tools/list for repeated calls)', async () => {
    const f = await fakeVikunja();
    const a = new VikunjaAdapter({ config: cfgFor(f.url), roster: new Roster() });
    await a.dynamicTools(); await a.dynamicTools(); await a.dynamicTools();
    equal(f.calls.filter((m) => m === 'tools/list').length, 1);
    f.srv.close();
  });

  it('a token without mcp.access (403) or an old Vikunja yields no tools, not an error', async () => {
    const f = await fakeVikunja({ allow: false });
    const a = new VikunjaAdapter({ config: cfgFor(f.url), roster: new Roster() });
    deepEqual(await a.dynamicTools(), []);
    f.srv.close();
  });

  it('can be switched off, and has its own token override', async () => {
    const off = new VikunjaAdapter({ config: cfgFor(fake.url, { enabled: false }), roster: new Roster() });
    deepEqual(await off.dynamicTools(), []);
    const own = new VikunjaAdapter({ config: { ...cfgFor(fake.url, { token: 'mcp-token' }), vikunja: { enabled: true, url: fake.url, token: 'rest-only', mcp: { enabled: true, token: 'mcp-token' } } }, roster: new Roster() });
    equal((await own.dynamicTools()).length, 2);
  });

  it('Gateway.dynamicMcpTools merges adapters’ dynamic tools and status reports the count', async () => {
    const saved = { ...config.vikunja };
    Object.assign(config.vikunja, { enabled: true, url: fake.url, token: 'mcp-token', mcp: { enabled: true, token: '' } });
    try {
      const gw = new Gateway();
      const names = (await gw.dynamicMcpTools()).map((t) => t.name);
      deepEqual(names, ['vikunja_native_tasks_list', 'vikunja_native_find_action']);
      equal((await gw.adapters().find((x) => x.source === 'vikunja').status()).nativeMcpTools, 2);
    } finally {
      Object.assign(config.vikunja, saved);
    }
  });
});
