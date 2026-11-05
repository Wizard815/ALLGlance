// /mcp must serve any number of clients, one after another and concurrently.
import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import express from 'express';
import { Gateway } from '../src/gateway.js';
import { createMcpRouter } from '../src/mcp/server.js';

async function client(url) {
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = async (body) => {
    const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return { status: res.status, msg: line ? JSON.parse(line.slice(5)) : text ? JSON.parse(text) : null };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  return { init, tools: list.msg.result.tools.map((t) => t.name) };
}

test('several clients can connect in turn and at once (no one-session lockout)', async () => {
  const app = express();
  app.use(createMcpRouter(new Gateway()));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  try {
    const first = await client(url);
    equal(first.init.status, 200);
    const second = await client(url); // used to fail: server already initialized
    equal(second.init.status, 200);
    deepEqual(second.tools, first.tools);
    const [a, b, c] = await Promise.all([client(url), client(url), client(url)]);
    equal(a.tools.length > 0 && b.tools.length === a.tools.length && c.tools.length === a.tools.length, true);
    const get = await fetch(url);
    equal(get.status, 405);
  } finally {
    srv.close();
  }
});
