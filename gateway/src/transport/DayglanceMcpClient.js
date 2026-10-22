// MCP client transport for dayGLANCE's desktop Electron MCP server.
//
// dayGLANCE exposes a real Model Context Protocol server on loopback
// (electron/mcpPort.ts DEFAULT_MCP_PORT = 7893). It is bearer-token gated
// (electron/mcpAuth.ts) and writes a { port, token } discovery file where a
// bridge can find it (electron/mcpDiscovery.ts). We speak Streamable-HTTP MCP
// to it: initialize → tools/list → tools/call, carrying the bearer token on
// every request.
//
// The tools dayGLANCE actually ships (electron/mcpReadTools.ts +
// mcpWriteTools.ts):
//   • dayglance_ping                    — connectivity check (no data)
//   • dayglance_get_today               — today's schedule { blocks, frames }
//   • dayglance_get_day { date }        — one day's schedule { blocks, frames }
//   • dayglance_list_unscheduled_tasks  — the inbox (paginated)
//   • dayglance_list_users              — household assignees (multi-user only)
//   • dayglance_get_goal_progress       — goal/project progress
//   • dayglance_create_task / update_task / schedule_task / move_block /
//     resize_block / set_task_completion — writes
//
// IMPORTANT — this client used to call dayglance_roster / dayglance_list_tasks
// / dayglance_list_blocks, which DO NOT EXIST in dayGLANCE. Those calls 401'd
// (no auth) and returned nothing. Callers must use the real tools above.
//
// NOTE on ownership: the read blocks returned by get_day do NOT carry the
// assignee (only list_users returns { id, name }). Per-user filtering of day
// blocks is therefore not possible over MCP — callers get the full family day.
// The localStorage/desktop fallback DOES carry assignedUserSyncIds, so owner
// scoping still works there.
//
// If dayGLANCE isn't reachable (Docker web build has no MCP), this throws and
// the adapter falls back to the Playwright reader.

import { readFile, access } from 'node:fs/promises';

function defaultTokenPath() {
  // Match mcpDiscovery.discoveryFilePath() for linux: XDG_CONFIG_HOME ||
  // ~/.config, then dayglance/mcp.json. The gateway only uses this when the
  // desktop app runs on the same host (dev / Unraid appdata); otherwise the
  // operator sets DAYGLANCE_MCP_TOKEN explicitly.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : `${process.env.HOME || ''}/.config`;
  return `${base}/dayglance/mcp.json`;
}

export class DayglanceMcpClient {
  constructor({ port = 7893, host = '127.0.0.1', token = null, tokenPath = null } = {}) {
    this.port = port;
    this.host = host;
    this.baseUrl = `http://${host}:${port}/mcp`;
    this.token = token ?? null;
    this.tokenPath = tokenPath || defaultTokenPath();
    this.sessionId = null;
  }

  async #readToken() {
    if (this.token) return this.token;
    try {
      await access(this.tokenPath);
      const raw = await readFile(this.tokenPath, 'utf8');
      const parsed = JSON.parse(raw);
      // discovery file body is { port, token }; prefer an explicit token.
      this.token = parsed && typeof parsed.token === 'string' ? parsed.token : null;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  async #request(method, params = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const token = await this.#readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const body = { jsonrpc: '2.0', id: 1, method, params };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`dayGLANCE MCP ${method} failed: ${res.status} ${res.statusText}`);
    }
    // Streamable-HTTP MCP replies as text/event-stream ("event: message\n
    // data: {jsonrpc...}") for requests with a result, and 202 with an empty
    // body for notifications. Parse BOTH plus a plain application/json body.
    if (res.status === 202 || res.status === 204) return null;
    const ctype = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!text) return null;
    if (ctype.includes('text/event-stream')) {
      // Concatenate `data:` lines of the first event carrying a JSON payload.
      const dataLines = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      for (const d of dataLines) {
        try { return JSON.parse(d); } catch { /* keep scanning */ }
      }
      throw new Error(`dayGLANCE MCP ${method}: no JSON payload in SSE response`);
    }
    return JSON.parse(text);
  }

  async #callTool(name, args) {
    const res = await this.#request('tools/call', { name, arguments: args });
    const result = res?.result ?? {};
    // Prefer structuredContent (typed), fall back to the text payload.
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.[0]?.text;
    if (!text) return result;
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed ? parsed : text;
    } catch {
      return text;
    }
  }

  /** Initialize the MCP session (handshake) so tools/call carries a session id. */
  async #ensureSession() {
    if (this.sessionId) return;
    const res = await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'allglance-gateway', version: '0.1.0' },
    });
    this.sessionId = res?.result?.sessionId ?? null;
    if (this.sessionId) await this.#request('notifications/initialized', {});
  }

  /** dayglance_ping — connectivity check only (no user data). */
  async ping() {
    const res = await this.#callTool('dayglance_ping', {});
    return res && res.ok !== false;
  }

  /** List the tools dayGLANCE exposes (mainly for diagnostics). */
  async listTools() {
    const res = await this.#request('tools/list', {});
    return (res?.result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** Today's schedule: { blocks, frames }. */
  async getToday() {
    return this.#callTool('dayglance_get_today', {});
  }

  /** One day's schedule by local calendar date YYYY-MM-DD. */
  async getDay(date) {
    return this.#callTool('dayglance_get_day', { date });
  }

  /** The inbox of unscheduled tasks (paginated). */
  async listUnscheduled({ limit = 100, cursor = null, scope = 'all', includeCompleted = true } = {}) {
    const args = { limit, scope, include_completed: includeCompleted };
    if (cursor) args.cursor = cursor;
    return this.#callTool('dayglance_list_unscheduled_tasks', args);
  }

  /** Household assignees (multi-user mode only): { users: [{ id, name }] }. */
  async listUsers() {
    return this.#callTool('dayglance_list_users', {});
  }

  /** Goal/project progress. */
  async getGoalProgress({ goal_id = null, window = 'active' } = {}) {
    const args = { window };
    if (goal_id) args.goal_id = goal_id;
    return this.#callTool('dayglance_get_goal_progress', args);
  }

  /** Read a day's blocks + frames for the adapter. */
  async readDay(date) {
    const data = date === 'today' ? await this.getToday() : await this.getDay(date);
    return { blocks: data?.blocks ?? [], frames: data?.frames ?? [] };
  }

  /**
   * Read dayGLANCE state. Prefers the MCP transport; throws if unreachable so
   * the caller can fall back to the localStorage/Playwright reader.
   *
   * Returns the SAME shape as the localStorage reader ({ tasks, blocks, users,
   * meUserSyncId }) so the adapter's #normalize handles both transports through
   * one code path. Inbox items are mapped into `tasks` with `deadline` →
   * `due_date`; blocks are returned as-is. Neither MCP path carries the
   * assignee on individual items (see the adapter's ownership note), so
   * owner_id stays null — only the roster (users) is populated.
   */
  async read(date = 'today') {
    await this.#ensureSession();
    const { blocks } = await this.readDay(date);
    const inbox = await this.listUnscheduled({});
    const users = await this.listUsers().catch(() => ({ users: [] }));
    const tasks = (inbox?.items ?? []).map((t) => {
      const row = { ...t };
      // dayGLANCE inbox items carry the due date as `deadline`; taskOf reads
      // due_date/due/dueDate, so expose it there for canonical mapping.
      if (t.deadline) row.due_date = t.deadline;
      return row;
    });
    return {
      tasks,
      blocks,
      users: users?.users ?? [],
      meUserSyncId: null, // list_users does not report "me"; roster carries all assignees.
    };
  }

  async status() {
    try {
      const alive = await this.ping();
      return { ok: alive, label: 'dayGLANCE (MCP)' };
    } catch (err) {
      return { ok: false, error: err.message, label: 'dayGLANCE (MCP)' };
    }
  }
}

export default DayglanceMcpClient;
