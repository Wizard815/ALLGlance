// Container-native dayGLANCE MCP server.
//
// WHY THIS EXISTS
// dayGLANCE's MCP ships inside the Electron main process and reads state over
// an IPC "renderer bridge". The Docker image is nginx + a static SPA + a small
// Node proxy — no Electron, no renderer. dayGLANCE's own spec (§4.4) resolves a
// headless Docker MCP as "no" *for dayGLANCE* and names the missing piece: "a
// CLI that runs the sync client locally with a user-supplied passphrase,
// decrypts in that process, and serves MCP. That is a separate product."
//
// This is that product, minus the decryption for now: it reuses dayGLANCE's
// REAL pure model (vendored verbatim under ./model/) and serves the same tools
// over Streamable HTTP, with the same output shapes — so a client sees exactly
// what the Electron MCP reports. The only substitution is the data SOURCE:
// instead of an Electron renderer, it reads a state document from disk (and,
// later, from GLANCEvault).
//
// The model in ./model/ is copied from apps/dayglance/src/utils + agenda-core
// by scripts/vendor-model.mjs. Do not hand-edit it; re-vendor instead.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { handleMcpRequest } from './model/mcpReadModel.js';
import { handleMcpWrite } from './model/mcpWriteModel.js';
import { createStateStore } from './state.mjs';
import { checkBearerToken, unauthorizedResponse } from './auth.mjs';
import { resolveMcpPort } from './port.mjs';
import { isValidLocalDate } from './dates.mjs';
import { paginate } from './paginate.mjs';
import { resolveInboxFilter } from './inboxFilter.mjs';
import { planCreateTask } from './createArgs.mjs';
import { planUpdateTask } from './updateArgs.mjs';
import { parseStart } from './parseStart.mjs';
import { validateDurationMinutes } from './localTime.mjs';

const SERVER_NAME = 'dayGLANCE';
const SERVER_VERSION = '0.1.0-container';

function localDateOfNow(tz) {
  // Local calendar date for the given IANA zone, via Intl (no Date-mutation
  // DST traps) — mirrors mcpDates.localDateOf.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Build one McpServer per request (dayGLANCE's §3.7 factory discipline: no
 * app-level state lives on the server instance).
 */
function buildServer(store, deps) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  const err = (code, message) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] });

  const readState = async () => (await store.get()).state;

  const getDay = async (date) => {
    const state = await readState();
    const r = handleMcpRequest(state, { method: 'get_day', params: { date, include_native: false } });
    if (!r.ok) return err(r.error.code, r.error.message);
    return ok({ date, timezone: deps.timeZone(), ...r.data });
  };

  server.registerTool('dayglance_ping', {
    description: 'Connectivity check: confirms the containerized dayGLANCE MCP is reachable. Does not touch user data.',
  }, async () => ok({ ok: true, server: 'dayGLANCE MCP (container)' }));

  server.registerTool('dayglance_get_today', {
    description: "Today's schedule from dayGLANCE (container). Resolves the current LOCAL calendar date. Times are local wall-clock HH:MM.",
  }, async () => getDay(localDateOfNow(deps.timeZone())));

  server.registerTool('dayglance_get_day', {
    description: 'The dayGLANCE schedule for one LOCAL calendar date (YYYY-MM-DD). Times are local wall-clock HH:MM.',
    inputSchema: { date: z.string().describe('Local calendar date, strict YYYY-MM-DD. Not a timestamp.') },
  }, async ({ date }) => {
    if (!isValidLocalDate(date)) {
      return err('validation', `date must be a real local calendar date in strict YYYY-MM-DD form, got ${JSON.stringify(date)}`);
    }
    return getDay(date);
  });

  server.registerTool('dayglance_list_unscheduled_tasks', {
    description: 'The dayGLANCE inbox: tasks not yet scheduled. Paginated; pass next_cursor back as cursor. Bucket List items are never returned.',
    inputSchema: {
      limit: z.number().int().optional().describe('Page size, 1-500. Default 100.'),
      cursor: z.string().optional().describe('Opaque cursor from a previous response next_cursor.'),
      scope: z.enum(['all', 'standalone', 'project']).optional().describe('Which inbox tasks. Default all.'),
      include_completed: z.boolean().optional().describe('Default true. Pass false for open tasks only.'),
    },
  }, async ({ limit, cursor, scope, include_completed }) => {
    const resolved = resolveInboxFilter({ scope, include_completed });
    if (!resolved.ok) return err('validation', resolved.message);
    const state = await readState();
    const r = handleMcpRequest(state, { method: 'list_unscheduled', params: { filter: resolved.filter } });
    if (!r.ok) return err(r.error.code, r.error.message);
    const page = paginate(r.data.items ?? [], { limit, cursor, filterKey: resolved.filter.key });
    if (!page.ok) return err('validation', page.reason);
    return ok({ items: page.items, truncated: page.truncated, next_cursor: page.nextCursor, total: page.total, timezone: deps.timeZone() });
  });

  server.registerTool('dayglance_list_users', {
    description: 'The household members tasks can be assigned to (multi-user mode). Returns active users as { id, name }.',
  }, async () => {
    const state = await readState();
    const r = handleMcpRequest(state, { method: 'list_users', params: {} });
    if (!r.ok) return err(r.error.code, r.error.message);
    return ok({ ...r.data, timezone: deps.timeZone() });
  });

  server.registerTool('dayglance_get_goal_progress', {
    description: 'Goal and project progress from dayGLANCE (container). Scope with goal_id; window is active (default) or all.',
    inputSchema: {
      goal_id: z.string().optional().describe('Narrow to one goal by id.'),
      window: z.enum(['active', 'all']).optional().describe("Status scope. Default 'active'."),
    },
  }, async ({ goal_id, window }) => {
    const params = {};
    if (goal_id !== undefined) params.goal_id = goal_id;
    if (window !== undefined) params.window = window;
    const state = await readState();
    const r = handleMcpRequest(state, { method: 'goal_progress', params });
    if (!r.ok) return err(r.error.code, r.error.message);
    return ok({ ...r.data, timezone: deps.timeZone() });
  });

  // ---- Write tools (create/update/schedule/complete) ----
  // The vendored handleMcpWrite expects the RENDERER mutation param names
  // (camelCase), exactly as the Electron tool handlers map them. Each handler
  // below mirrors mcpWriteTools.ts's wire→mutation mapping.
  const write = async (method, params) => {
    const { state, setters } = await store.beginWrite();
    const r = handleMcpWrite(state, setters, { method, params });
    if (!r.ok) return err(r.error.code, r.error.message);
    await store.commit();
    const { undo, ...data } = r.data ?? {};
    return ok(data);
  };

  server.registerTool('dayglance_create_task', {
    description: 'Create a dayGLANCE task. Without start: an unscheduled inbox task. With start: a scheduled task placed on the calendar.',
    inputSchema: {
      title: z.string(),
      notes: z.string().optional(),
      priority: z.number().int().optional(),
      deadline: z.string().optional().describe('Inbox task deadline, YYYY-MM-DD.'),
      start: z.string().optional().describe('Local "YYYY-MM-DD HH:MM" (timed) or bare "YYYY-MM-DD" with all_day.'),
      duration_minutes: z.number().int().optional(),
      all_day: z.boolean().optional(),
    },
  }, async (args) => {
    const planned = planCreateTask(args, deps.timeZone());
    if (!planned.ok) return err(planned.code, planned.message);
    return write('create_task', { ...planned.plan, nowIso: new Date().toISOString() });
  });

  server.registerTool('dayglance_update_task', {
    description: 'Edit fields of an existing dayGLANCE task (inbox or scheduled). Absent arguments are left alone.',
    inputSchema: {
      task_id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      priority: z.number().int().optional(),
      deadline: z.string().optional(),
      clear_fields: z.array(z.string()).optional(),
    },
  }, async (args) => {
    const planned = planUpdateTask(args, /* multiUser */ false);
    if (!planned.ok) return err(planned.code, planned.message);
    return write('update_task', planned.plan);
  });

  server.registerTool('dayglance_schedule_task', {
    description: 'Schedule an unscheduled inbox task onto a day and time. start is local "YYYY-MM-DD HH:MM". Inbox-only priority/deadline are dropped by design.',
    inputSchema: {
      task_id: z.string(),
      start: z.string().describe('Local "YYYY-MM-DD HH:MM".'),
      duration_minutes: z.number().int().optional().describe('1-1440. Defaults to the task duration, then 30.'),
    },
  }, async ({ task_id, start, duration_minutes }) => {
    const parsed = parseStart(start, deps.timeZone());
    if (parsed.invalid) return err('validation', parsed.invalid);
    if (duration_minutes !== undefined) {
      const durationError = validateDurationMinutes(duration_minutes);
      if (durationError) return err('validation', durationError);
    }
    return write('schedule_task', {
      taskId: task_id, date: parsed.date, startTime: parsed.time, durationMinutes: duration_minutes,
      nowIso: new Date().toISOString(),
    });
  });

  server.registerTool('dayglance_move_block', {
    description: 'Move a scheduled block to a new local start "YYYY-MM-DD HH:MM" (same or different day).',
    inputSchema: {
      block_id: z.string(),
      new_start: z.string().describe('Local "YYYY-MM-DD HH:MM".'),
    },
  }, async ({ block_id, new_start }) => {
    const parsed = parseStart(new_start, deps.timeZone());
    if (parsed.invalid) return err('validation', parsed.invalid);
    return write('move_block', { blockId: block_id, date: parsed.date, startTime: parsed.time });
  });

  server.registerTool('dayglance_resize_block', {
    description: 'Change the duration of a scheduled block without moving its start.',
    inputSchema: { block_id: z.string(), duration_minutes: z.number().int().describe('New duration, 1-1440 minutes.') },
  }, async ({ block_id, duration_minutes }) => {
    const durationError = validateDurationMinutes(duration_minutes);
    if (durationError) return err('validation', durationError);
    return write('resize_block', { blockId: block_id, durationMinutes: duration_minutes });
  });

  server.registerTool('dayglance_set_task_completion', {
    description: 'Set a task completion state (a setter, not a toggle). Works for scheduled blocks and inbox tasks.',
    inputSchema: { task_id: z.string(), completed: z.boolean() },
  }, async ({ task_id, completed }) => write('set_completion', {
    taskId: task_id, completed, todayStr: localDateOfNow(deps.timeZone()),
  }));

  return server;
}

export function startDayglanceMcpServer(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const logError = opts.logError ?? ((m) => console.error(m));

  const token = opts.token ?? process.env.DAYGLANCE_MCP_TOKEN ?? '';
  const resolved = resolveMcpPort(opts.port ?? process.env.DAYGLANCE_MCP_PORT);
  if (!resolved.ok) { logError(`[dayGLANCE MCP] not started: ${resolved.reason}`); return null; }

  const store = opts.store ?? createStateStore({
    file: process.env.DAYGLANCE_STATE_FILE || '/data/dayglance-state.json',
    vault: opts.vault,
  });

  const deps = {
    timeZone: () => opts.timeZone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  };

  const port = resolved.port;
  const srv = http.createServer((req, res) => {
    let path;
    try { path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname; } catch { path = '/'; }
    if (path !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }

    // Bearer token is required only when configured (empty = open, loopback-only
    // posture). the container binds inside the compose network, so set a token.
    if (token) {
      const auth = checkBearerToken(req.headers['authorization'], token);
      if (!auth.ok) {
        const rej = unauthorizedResponse();
        res.writeHead(rej.status, rej.headers); res.end(rej.body); return;
      }
    }

    void handleMcp(req, res, store, deps, logError);
  });

  srv.on('error', (e) => logError(`[dayGLANCE MCP] listener error: ${e.message}`));
  srv.listen(port, '0.0.0.0', () => log(`[dayGLANCE MCP] listening on 0.0.0.0:${port}/mcp (container mode)`));
  return srv;
}

async function handleMcp(req, res, store, deps, logError) {
  // Stateless per-request transport: build a fresh server+transport each call.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(store, deps);
  res.on('close', () => { transport.close(); server.close?.(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    logError(`[dayGLANCE MCP] handler error: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  }
}

export default startDayglanceMcpServer;
