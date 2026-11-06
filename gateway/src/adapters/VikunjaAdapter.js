// vikunja adapter — the server-side hub (DESIGN.md §4.1).
//
// vikunja is the only app with a real server, so this adapter is the backbone.
// It:
//   • reads tasks + projects via REST `/api/v2/`
//   • writes tasks via REST (always-on, server-side)
//   • maps vikunja's `assigned_users` → our normalized owner_id
//   • registers vikunja MCP tools (list/create/read/complete)
//   • exposes REST routes under /api/allglance/vikunja/*
//
// vikunja's *native MCP* (auto-generated at `/api/v2/mcp`) is noted in
// DESIGN.md as an optional enhancement — the adapter currently talks REST so
// ownership scoping stays in our hands rather than vikunja's opaque tool names.

import { BaseAdapter } from './BaseAdapter.js';
import { taskOf, toPriority } from '../model.js';
import { fetchJson } from '../lib/fetch.js';
import McpHttpClient from '../transport/McpHttpClient.js';

const NATIVE_PREFIX = 'vikunja_native_';
// The discovery tools: with find_action/do_action an agent can reach every other
// Vikunja action its token allows, without a dozen near-duplicate tools.
const NATIVE_META = new Set(['find_action', 'do_action', 'filter_syntax']);
const NATIVE_TTL_MS = 5 * 60 * 1000;

export class VikunjaAdapter extends BaseAdapter {
  source = 'vikunja';
  label = 'vikunja';

  #token;
  #baseUrl;

  constructor(opts) {
    super(opts);
    this.enabled = opts.config.vikunja.enabled;
    this.#baseUrl = opts.config.vikunja.url.replace(/\/$/, '');
    this.#token = opts.config.vikunja.token;
    const mcp = opts.config.vikunja.mcp ?? {};
    this.#nativeEnabled = Boolean(mcp.enabled);
    this.#native = new McpHttpClient({
      url: `${this.#baseUrl}/api/v2/mcp`,
      token: mcp.token || this.#token,
      timeoutMs: 8000,
    });
  }

  #native;
  #nativeEnabled = false;
  #nativeCache = { at: 0, tools: [] };
  #nativeWarned = false;

  /**
   * Vikunja's own MCP tools (2.7+), discovered at runtime and re-exposed as
   * `vikunja_native_<name>` so one MCP endpoint carries both the AllGLANCE tools
   * (owner-scoped across apps) and everything Vikunja itself offers. The set is
   * whatever the token is authorised for (Vikunja filters it), cached for a few
   * minutes, and empty (never an error) if the server is old, off, or the token
   * lacks mcp.access. Native tools are Vikunja's own: they are NOT owner-scoped.
   */
  async dynamicTools() {
    const mode = this.config.vikunja.mcp?.tools ?? 'meta';
    if (!this.enabled || !this.#nativeEnabled || mode === 'off') return [];
    if (Date.now() - this.#nativeCache.at < NATIVE_TTL_MS) return this.#nativeCache.tools;
    let tools = [];
    try {
      const listed = await this.#native.listTools();
      tools = listed.filter((t) => mode === 'all' || NATIVE_META.has(t.name)).map((t) => ({
        name: `${NATIVE_PREFIX}${t.name}`,
        description: `[Vikunja native, advanced: not owner-scoped. Prefer the allglance_* tools for everyday task work.] ${t.description ?? ''}`.trim(),
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        handler: async (args) => this.#native.callTool(t.name, args ?? {}),
      }));
      this.#nativeWarned = false;
    } catch (err) {
      if (!this.#nativeWarned) {
        console.warn(`[vikunja] native MCP tools unavailable: ${err.message}`);
        this.#nativeWarned = true;
      }
    }
    this.#nativeCache = { at: Date.now(), tools };
    return tools;
  }

  #auth() {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  async status() {
    try {
      // Reachability, then token validity via a cheap authenticated read.
      await fetchJson(`${this.#baseUrl}/health`, { timeoutMs: 5000 });
      if (this.#token) {
        await fetchJson(`${this.#baseUrl}/api/v2/projects?limit=1`, {
          headers: this.#auth(),
          timeoutMs: 5000,
        });
      }
      const native = this.#nativeEnabled ? (await this.dynamicTools()).length : null;
      return { ok: true, authenticated: !!this.#token, label: this.label, nativeMcpTools: native };
    } catch (err) {
      return { ok: false, error: err.message, label: this.label };
    }
  }

  /**
   * Fetch every page of a vikunja /api/v2 list. v2 paginates with `page` /
   * `per_page` and wraps results in { items, total, page, per_page,
   * total_pages }. per_page is silently capped server-side, so the loop is
   * driven by total_pages rather than by guessing the page size.
   */
  async #paginate(endpoint, params = {}, acc = []) {
    const url = new URL(`${this.#baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, 50); page++) {
      url.searchParams.set('page', String(page));
      const res = await fetchJson(url.toString(), { headers: this.#auth(), timeoutMs: 10000 });
      acc.push(...(res?.items ?? []));
      totalPages = res?.total_pages ?? 1;
    }
    return acc;
  }

  /**
   * Fill the roster with everyone who has access to a project (needs the API
   * token's `projects.users_search` permission). Without it the roster still
   * learns people as tasks are read (assignees and creators), so this degrades
   * to "who has appeared on a task" rather than failing.
   */
  async refreshRoster() {
    try {
      const projects = await this.#paginate('/api/v2/projects');
      for (const project of projects) {
        if (project.is_archived) continue;
        const users = await this.#paginate(`/api/v2/projects/${project.id}/users/search`);
        for (const u of users) {
          if (u?.id) this.roster.addVikunjaUser({ ...u, fullName: u.name || undefined });
        }
      }
    } catch {
      // token lacks projects.users_search (or an older server): keep what tasks taught us
    }
    return this.roster.list();
  }

  /** Read tasks, scoped to `owner` when provided. */
  async readTasks(owner = null) {
    const projects = await this.#paginate('/api/v2/projects');
    const tasks = [];
    const roster = this.roster;
    for (const project of projects) {
      if (project.is_archived) continue;
      const ptasks = await this.#paginate(`/api/v2/projects/${project.id}/tasks`);
      for (const t of ptasks) {
        // vikunja v2 lists a task's assignees as user objects in assignees[].
        let ownerId = null;
        const assignees = t.assignees ?? [];
        if (assignees.length) {
          const ids = assignees.map((a) => String(a.id));
          ownerId = owner ? (ids.includes(String(owner)) ? owner : null) : ids[0];
        }
        if (t.created_by?.id) roster.addVikunjaUser({ ...t.created_by, fullName: t.created_by.name || undefined });
        for (const a of assignees) {
          if (a?.id) roster.addVikunjaUser({ ...a, fullName: a.name || undefined });
        }
        tasks.push(
          taskOf('vikunja', {
            ...t,
            // vikunja serializes an unset date as year 0001.
            due_date: t.due_date && !t.due_date.startsWith('0001') ? t.due_date : null,
            project_id: project.id,
          }, ownerId)
        );
      }
    }
    return { tasks: owner ? tasks.filter((t) => t.owner_id === owner) : tasks };
  }

  /** Create a task in vikunja. Returns the canonical task or null on failure. */
  /**
   * Resolve the project a new task goes in: a numeric id, a project NAME
   * (case-insensitive), or — when none is given — VIKUNJA_DEFAULT_PROJECT_ID, else
   * the first project Vikunja lists (normally Inbox).
   */
  async #resolveProject(project) {
    const given = project === undefined || project === null || project === '' ? this.config.vikunja.defaultProjectId : project;
    if (given !== undefined && given !== '' && /^\d+$/.test(String(given))) return Number(given);
    const projects = await this.#paginate('/api/v2/projects');
    if (given !== undefined && given !== '') {
      const hit = projects.find((p) => String(p.title ?? '').toLowerCase() === String(given).toLowerCase());
      if (!hit) throw new Error(`No Vikunja project named "${given}". Projects: ${projects.map((p) => p.title).join(', ')}`);
      return hit.id;
    }
    if (!projects.length) throw new Error('Vikunja has no projects to put the task in');
    return projects[0].id;
  }

  async writeTask({ title, due_date, owner_id, project_id, project, priority, notes }) {
    const resolved = await this.#resolveProject(project ?? project_id);
    const payload = { title };
    if (notes) payload.description = String(notes);
    if (priority !== undefined) payload.priority = toPriority(priority);
    // Task fields are `due_date` (RFC3339); a bare YYYY-MM-DD is promoted to UTC midnight.
    if (due_date) payload.due_date = /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? `${due_date}T00:00:00Z` : due_date;
    const data = await fetchJson(`${this.#baseUrl}/api/v2/projects/${resolved}/tasks`, {
      method: 'POST',
      headers: { ...this.#auth() },
      body: payload,
      timeoutMs: 10000,
    });
    if (!data?.id) return null;
    // Assignees are read-only on create in v2; assign via the dedicated endpoint.
    let assignedTo = null;
    if (owner_id) {
      const uid = this.#vikunjaUserId.get(String(owner_id)) ?? (/^\d+$/.test(String(owner_id)) ? Number(owner_id) : null);
      if (uid) {
        const ok = await fetchJson(`${this.#baseUrl}/api/v2/tasks/${data.id}/assignees`, {
          method: 'POST',
          headers: { ...this.#auth() },
          body: { user_id: Number(uid) },
          timeoutMs: 10000,
        }).then(() => true, () => false);
        if (ok) assignedTo = String(uid);
      }
    }
    return taskOf('vikunja', { ...data, project_id: resolved }, assignedTo, data.title);
  }

  /**
   * Update a task: any of done, priority (0-5), title, due_date (YYYY-MM-DD or
   * null to clear). Uses v2's PATCH (JSON merge patch); servers without it
   * get GET + PUT, which replaces the whole task with the merged fields.
   */
  async updateTask(id, patch = {}) {
    const taskId = Number(id);
    if (!taskId) throw new Error('task id must be a number');
    const body = {};
    if (patch.done !== undefined) body.done = Boolean(patch.done);
    if (patch.priority !== undefined) body.priority = toPriority(patch.priority);
    if (patch.title !== undefined) body.title = String(patch.title);
    if (patch.due_date !== undefined) body.due_date = patch.due_date ? (/^\d{4}-\d{2}-\d{2}$/.test(patch.due_date) ? `${patch.due_date}T00:00:00Z` : patch.due_date) : null;
    if (!Object.keys(body).length) throw new Error('nothing to update');
    const url = `${this.#baseUrl}/api/v2/tasks/${taskId}`;
    let data;
    try {
      data = await fetchJson(url, { method: 'PATCH', headers: { ...this.#auth(), 'content-type': 'application/merge-patch+json' }, body, timeoutMs: 10000 });
    } catch (err) {
      // A no-op update (e.g. marking an already-done task done) answers 304 Not
      // Modified: the task is already as asked, so that is success. Read it back.
      if (/ -> 304 /.test(err.message)) {
        data = await fetchJson(url, { headers: this.#auth(), timeoutMs: 10000 });
        return taskOf('vikunja', { ...(data ?? {}), id: data?.id ?? taskId }, null);
      }
      if (!/-> (405|404|415) /.test(err.message)) throw err;
      const current = await fetchJson(url, { headers: this.#auth(), timeoutMs: 10000 });
      data = await fetchJson(url, { method: 'PUT', headers: this.#auth(), body: { ...current, ...body }, timeoutMs: 10000 });
    }
    return taskOf('vikunja', { ...(data ?? {}), id: data?.id ?? taskId }, null);
  }

  /** Track vikunja user ids as we build tasks, for owner mapping. */
  #vikunjaUserId = new Map();

  #registerVikunjaUser = (id, name) => this.#vikunjaUserId.set(String(id), String(id));

  /**
   * Register vikunja MCP tools. Each tool is namespaced `vikunja_*` and takes
   * an optional owner_id for per-user scoping.
   */
  registerTools(server) {
    const tools = [];
    if (!server || !this.enabled) return tools;

    tools.push(
      {
        name: 'vikunja_list_tasks',
        description: 'List vikunja tasks across open projects. Optional owner_id scopes to one person.',
        inputSchema: {
          type: 'object',
          properties: {
            owner_id: { type: 'string', description: 'Restrict to a single owner (family member).' },
          },
        },
        handler: async (args) => {
          const { tasks } = await this.readTasks(args?.owner_id ?? null);
          return { content: [{ type: 'text', text: JSON.stringify({ source: 'vikunja', tasks }) }] };
        },
      },
      {
        name: 'vikunja_create_task',
        description: 'Create a vikunja task. Requires project_id; optional due_date and owner_id.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            project_id: { type: 'integer' },
            due_date: { type: 'string', description: "YYYY-MM-DD" },
            owner_id: { type: 'string' },
          },
          required: ['title', 'project_id'],
        },
        handler: async (args) => {
          const task = await this.writeTask(args);
          return { content: [{ type: 'text', text: JSON.stringify({ source: 'vikunja', task }) }] };
        },
      },
      {
        name: 'vikunja_update_task',
        description: 'Update a vikunja task: done, priority (0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 do now), title or due_date.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'integer' },
            done: { type: 'boolean' },
            priority: { type: 'integer', minimum: 0, maximum: 5 },
            title: { type: 'string' },
            due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear' },
          },
          required: ['task_id'],
        },
        handler: async ({ task_id, ...patch }) => {
          const task = await this.updateTask(task_id, patch);
          return { content: [{ type: 'text', text: JSON.stringify({ source: 'vikunja', task }) }] };
        },
      }
    );

    for (const tool of tools) {
      try {
        server.addTool?.({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        server.registerTool?.(tool.name, tool.handler);
      } catch {
        // Older SDK shape: some @modelcontextprotocol/sdk versions use registerTool.
      }
    }
    return tools;
  }

  /** Register vikunja REST routes under /api/allglance/vikunja. */
  registerRoutes(router) {
    if (!this.enabled) return [];
    const routes = [];

    router.get('/vikunja/tasks', async (req, res) => {
      try {
        const owner = req.query.owner ?? null;
        const { tasks } = await this.readTasks(owner);
        res.json({ source: 'vikunja', count: tasks.length, tasks });
      } catch (err) {
        res.status(502).json({ source: 'vikunja', error: err.message });
      }
    });
    routes.push('/vikunja/tasks');

    router.get('/vikunja/projects', async (req, res) => {
      try {
        const projects = await this.#paginate('/api/v2/projects');
        res.json({ source: 'vikunja', count: projects.length, projects });
      } catch (err) {
        res.status(502).json({ source: 'vikunja', error: err.message });
      }
    });
    routes.push('/vikunja/projects');

    router.post('/vikunja/tasks', async (req, res) => {
      try {
        const task = await this.writeTask(req.body ?? {});
        res.status(task ? 201 : 400).json({ source: 'vikunja', task });
      } catch (err) {
        res.status(502).json({ source: 'vikunja', error: err.message });
      }
    });
    routes.push('/vikunja/tasks');

    router.patch('/vikunja/tasks/:id', async (req, res) => {
      try {
        const task = await this.updateTask(req.params.id, req.body ?? {});
        res.json({ source: 'vikunja', task });
      } catch (err) {
        res.status(/must be a number|nothing to update/.test(err.message) ? 400 : 502).json({ source: 'vikunja', error: err.message });
      }
    });
    routes.push('/vikunja/tasks/:id (PATCH)');

    return routes;
  }
}

export default VikunjaAdapter;
