// Agents send words where dates belong and values outside the schema; the SDK
// does not check arguments, so the tools must refuse them before any app sees them.
import { describe, it } from 'node:test';
import { equal, ok, deepEqual, match, rejects } from 'node:assert/strict';
import express from 'express';
import { Gateway } from '../src/gateway.js';
import { createMcpRouter } from '../src/mcp/server.js';
import { taskOf } from '../src/model.js';

const T = (source, id, title, extra = {}) => taskOf(source, { id, title, ...extra }, null);

function gatewayWithWrites() {
  const gw = new Gateway();
  const reached = [];
  for (const a of gw.adapters()) {
    a.readTasks = async () => ({ tasks: a.source === 'vikunja'
      ? [T('vikunja', 1, 'Late', { due_date: '2026-11-01' }), T('vikunja', 2, 'Soon', { due_date: '2026-12-01' })] : [] });
    if (a.source === 'dayglance') a.readBlocks = async () => ({ blocks: [] });
    a.writeTask = async (d) => { reached.push(d); return T(a.source, 9, d.title); };
    if (a.updateTask) a.updateTask = async (id, p) => { reached.push({ id, ...p }); return T(a.source, id, 'x'); };
  }
  return { gw, reached };
}
const tool = (gw, name) => gw.registerMcpTools().find((t) => t.name === name);
const run = async (gw, name, args) => JSON.parse((await tool(gw, name).handler(args)).content[0].text);

describe('dates are checked, not compared as text', () => {
  it('list_tasks refuses a word as a due filter (it used to return every dated task as overdue)', async () => {
    const { gw } = gatewayWithWrites();
    await rejects(tool(gw, 'allglance_list_tasks').handler({ due_on_or_before: 'yesterday' }), /due_on_or_before must be a real date/);
    equal((await run(gw, 'allglance_list_tasks', { due_on_or_before: '2026-11-13' })).total, 1);
  });
  it('get_day and list_milestones refuse words and impossible days', async () => {
    const { gw } = gatewayWithWrites();
    await rejects(tool(gw, 'allglance_get_day').handler({ date: 'tomorrow' }), /date must be a real date/);
    await rejects(tool(gw, 'allglance_list_milestones').handler({ from: '2026-02-30' }), /from must be a real date/);
  });
  it('list_tasks refuses a status or source outside the enum (a typo used to mean "all")', async () => {
    const { gw } = gatewayWithWrites();
    await rejects(tool(gw, 'allglance_list_tasks').handler({ status: 'opne' }), /status must be one of open, done, all/);
    await rejects(tool(gw, 'allglance_list_tasks').handler({ source: 'lastglance' }), /source must be one of/);
  });
});

describe('writes are checked before they reach an app', () => {
  it('create_task refuses a bad due date, start, priority or source; nothing reaches the app', async () => {
    const { gw, reached } = gatewayWithWrites();
    const create = tool(gw, 'allglance_create_task').handler;
    await rejects(create({ title: 'A', due_date: 'tomorrow' }), /due_date must be a real date.*Nothing was changed/);
    await rejects(create({ title: 'B', priority: 9 }), /priority must be a whole number 0-5/);
    await rejects(create({ title: 'C', source: 'dayglance', start: 'tomorrow 3pm' }), /start must be "YYYY-MM-DD HH:MM"/);
    await rejects(create({ title: 'C', source: 'dayglance', start: '2026-11-20 25:00' }), /start must be/);
    await rejects(create({ title: 'D', source: 'lastglance' }), /source must be one of vikunja, dayglance/);
    await rejects(create({ title: '  ' }), /title is empty/);
    deepEqual(reached, []);
  });
  it('create_task still accepts good input, including an all-day start', async () => {
    const { gw, reached } = gatewayWithWrites();
    ok((await run(gw, 'allglance_create_task', { title: 'Ok', due_date: '2026-11-20', priority: 3 })).created);
    ok((await run(gw, 'allglance_create_task', { title: 'Day', source: 'dayglance', start: '2026-11-20', all_day: true })).created);
    ok((await run(gw, 'allglance_create_task', { title: 'Meet', source: 'dayglance', start: '2026-11-20 15:30' })).created);
    equal(reached.length, 3);
  });
  it('update_task names read-only apps, needs an id and at least one change', async () => {
    const { gw, reached } = gatewayWithWrites();
    const update = tool(gw, 'allglance_update_task').handler;
    await rejects(update({ source: 'lastglance', id: '1', done: true }), /read-only here/);
    await rejects(update({ source: 'vikunja', done: true }), /id is required/);
    await rejects(update({ source: 'vikunja', id: '1' }), /at least one change/);
    await rejects(update({ source: 'vikunja', id: '1', due_date: 'next week' }), /due_date must be a real date/);
    ok((await run(gw, 'allglance_update_task', { source: 'vikunja', id: '1', due_date: null })).updated, 'null still clears the due date');
    equal(reached.length, 1);
  });
});

describe('protocol surface', () => {
  it('tools/list carries read-only hints and the server sends instructions', async () => {
    const app = express();
    app.use(createMcpRouter(new Gateway()));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    const post = async (body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
      const line = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line.slice(5));
    };
    try {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
      match(init.result.instructions, /YYYY-MM-DD/);
      const { tools } = (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result;
      const by = (n) => tools.find((t) => t.name === n);
      equal(by('allglance_list_tasks').annotations.readOnlyHint, true);
      equal(by('allglance_create_task').annotations.readOnlyHint, false);
      equal(by('allglance_update_task').annotations.destructiveHint, false);
      for (const t of tools) for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) ok(p.description, `${t.name}.${k} needs a description`);
    } finally {
      srv.close();
    }
  });
});
