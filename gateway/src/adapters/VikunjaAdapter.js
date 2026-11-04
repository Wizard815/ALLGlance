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
      // Reachability, then token validity via a cheap authenticated read.
      await fetchJson(`${this.#baseUrl}/health`, { timeoutMs: 5000 });
      if (this.#token) {
        await fetchJson(`${this.#baseUrl}/api/v2/projects?limit=1`, {
          headers: this.#auth(),
          timeoutMs: 5000,
        });
      }
      return { ok: true, authenticated: !!this.#token, label: this.label };
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
  async writeTask({ title, due_date, owner_id, project_id }) {
    const project = Number(project_id);
    if (!project) return null;
    const payload = { title };
    // Task fields are `due_date` (RFC3339); a bare YYYY-MM-DD is promoted to UTC midnight.
    if (due_date) payload.due_date = /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? `${due_date}T00:00:00Z` : due_date;
    const data = await fetchJson(`${this.#baseUrl}/api/v2/projects/${project}/tasks`, {
      method: 'POST',
      headers: { ...this.#auth(), 'Content-Type': 'application/json' },
      body: payload,
      timeoutMs: 10000,
    });
    if (!data?.id) return null;
    // Assignees are read-only on create in v2; assign via the dedicated endpoint.
    if (owner_id) {
      const uid = this.#vikunjaUserId.get(String(owner_id)) ?? (/^\d+$/.test(String(owner_id)) ? Number(owner_id) : null);
      if (uid) {
        await fetchJson(`${this.#baseUrl}/api/v2/tasks/${data.id}/assignees`, {
          method: 'POST',
          headers: { ...this.#auth(), 'Content-Type': 'application/json' },
          body: { user_id: Number(uid) },
          timeoutMs: 10000,
        }).catch(() => null);
      }
    }
    return taskOf('vikunja', { ...data, project_id: project }, null, data.title);
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
