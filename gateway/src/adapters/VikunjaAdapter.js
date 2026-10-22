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
import { taskOf } from '../model.js';
import { fetchJson } from '../lib/fetch.js';

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
  }

  #auth() {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  async status() {
    try {
      const res = await fetchJson(`${this.#baseUrl}/api/v2/authors/me`, {
        headers: this.#auth(),
        timeoutMs: 5000,
      });
      const me = res?.data?.id ?? res?.id ?? null;
      return { ok: !!me, me, label: this.label };
    } catch (err) {
      return { ok: false, error: err.message, label: this.label };
    }
  }

  /** Fetch a vikunja page set with cursor pagination (limit 100, offset by keyset). */
  async #paginate(endpoint, params = {}, acc = []) {
    const url = new URL(`${this.#baseUrl}${endpoint}`);
    url.searchParams.set('limit', '100');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    // vikunja uses `limit`/`offset`; keep it simple with a bounded loop.
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      url.searchParams.set('offset', String(offset));
      const res = await fetchJson(url.toString(), { headers: this.#auth(), timeoutMs: 10000 });
      const items = res?.data ?? [];
      acc.push(...items);
      if (items.length < 100) break;
      offset += items.length;
    }
    return acc;
  }

  /** Read tasks, scoped to `owner` when provided. */
  async readTasks(owner = null) {
    const projects = await this.#paginate('/api/v2/projects');
    const tasks = [];
    const roster = this.roster;
    for (const project of projects) {
      if (project.closed) continue;
      const ptasks = await this.#paginate('/api/v2/tasks', { project_id: project.id });
      for (const t of ptasks) {
        // vikunja assigns a task to zero or more users via assigned_users[].user.id.
        let ownerId = null;
        const assignees = t.assigned_users ?? [];
        if (assignees.length) {
          const ids = assignees.map((a) => String(a.user?.id ?? a.user));
          ownerId = owner ? (ids.includes(String(owner)) ? owner : null) : ids[0];
        }
        roster.addVikunjaUser(t.user || {});
        for (const a of assignees) {
          if (a.user?.id) roster.addVikunjaUser(a.user);
        }
        tasks.push(
          taskOf('vikunja', {
            ...t,
            due_date: t.due,
            project_id: project.id,
          }, ownerId)
        );
      }
    }
    return { tasks: owner ? tasks.filter((t) => t.owner_id === owner) : tasks };
  }

  /** Create a task in vikunja. Returns the canonical task or null on failure. */
  async writeTask({ title, due_date, owner_id, project_id }) {
    const project = Number(project_id);
    if (!project) return null;
    const payload = { title };
    if (due_date) payload.due = due_date;
    if (owner_id) {
      // Find a vikunja user id matching our normalized owner, else store owner_id in extra.
      const person = this.roster.get(owner_id);
      const uid = this.#vikunjaUserId(owner_id);
      if (uid) payload.assigned_user_ids = [uid];
    }
    const res = await fetchJson(`${this.#baseUrl}/api/v2/tasks`, {
      method: 'POST',
      headers: { ...this.#auth(), 'Content-Type': 'application/json' },
      body: payload,
      timeoutMs: 10000,
    });
    const data = res?.data;
    if (!data) return null;
    return taskOf('vikunja', { ...data, due_date: data.due, project_id: project }, null, data.title);
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

    return routes;
  }
}

export default VikunjaAdapter;
