// Orchestrator — wires all enabled adapters into one unified task/calendar API.
// Handles the unification layer (DESIGN.md §5), per-user scoping via the roster,
// and delegates MCP tool + REST route registration to each adapter.

import { buildTools } from './mcp/tools.js';
import { compactTask, compactBlock, compactChore, compactMilestone, byDue } from './mcp/format.js';
import { Roster } from './identity/roster.js';
import config from './config.js';
import { VikunjaAdapter } from './adapters/VikunjaAdapter.js';
import { DayglanceAdapter } from './adapters/DayglanceAdapter.js';
import { LastglanceAdapter } from './adapters/LastglanceAdapter.js';
import { LifeglanceAdapter } from './adapters/LifeglanceAdapter.js';

/** `{ unavailable, note }` fields for a tool result, or nothing when all sources answered. */
const unavailableNote = (list) => (list.length
  ? { unavailable: [...new Set(list)], note: 'These sources could not be reached just now, so this answer leaves them out. Do not treat it as complete; try again shortly.' }
  : {});

class GatewayError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export class Gateway {
  #adapters = new Map();
  roster;

  constructor() {
    this.roster = new Roster();
    this.#loadAdapters();
  }

  #loadAdapters() {
    // Eagerly wired so adapters are registered synchronously with `new Gateway()`.
    const registry = [
      ['vikunja', VikunjaAdapter],
      ['dayglance', DayglanceAdapter],
      ['lastglance', LastglanceAdapter],
      ['lifeglance', LifeglanceAdapter],
    ];
    for (const [name, Ctor] of registry) {
      try {
        const adapter = new Ctor({ roster: this.roster, config });
        if (adapter.enabled) {
          this.#adapters.set(name, adapter);
        } else {
          console.error(`[diag] ${name} constructed but disabled`);
        }
      } catch (e) {
        // Adapter unavailable (e.g. missing dependency); skip it.
        console.error(`[diag] ${name} FAILED:`, e.message);
      }
    }
  }

  adapters() {
    return [...this.#adapters.values()];
  }

  has(name) {
    return this.#adapters.has(name);
  }

  /** Read tasks across all sources, optionally scoped to an owner. */
  async readTasks(owner = null) {
    return (await this.readTasksDetailed(owner)).by;
  }

  /**
   * Like readTasks, but also says which sources could not be read (network down,
   * bad credentials...). One failing source never aborts the rest, but callers
   * that answer an agent must not present a partial answer as the whole one.
   * @returns {Promise<{ by: Record<string, object[]>, unavailable: string[] }>}
   */
  async readTasksDetailed(owner = null) {
    const by = { vikunja: [], dayglance: [], lastglance: [], lifeglance: [] };
    const unavailable = [];
    for (const a of this.adapters()) {
      try {
        const { tasks } = await a.readTasks(owner);
        by[a.source] = tasks;
      } catch {
        unavailable.push(a.source);
      }
    }
    return { by, unavailable };
  }

  /** Read the day's time blocks (dayGLANCE) for one date, optionally scoped. */
  async readBlocks(date, owner = null) {
    const adapter = this.#adapters.get('dayglance');
    if (!adapter) return { blocks: [] };
    const res = await adapter.readBlocks(date, owner);
    return res.blocks ?? [];
  }

  /** Read milestones (lifeGLANCE), optionally scoped. */
  async readMilestones(owner = null) {
    const adapter = this.#adapters.get('lifeglance');
    if (!adapter) return { milestones: [] };
    return (await adapter.readMilestones(owner)).milestones ?? [];
  }

  /** Read recent chores (lastGLANCE), optionally scoped. */
  async readChores(owner = null) {
    const adapter = this.#adapters.get('lastglance');
    if (!adapter) return { chores: [] };
    return (await adapter.readChores(owner)).chores ?? [];
  }

  /**
   * Create a task through the first writable source. Returns { source, task }.
   * @param {object} data
   */
  async createTask(data) {
    const target = data.source ? this.#adapters.get(data.source) : this.#adapters.get('vikunja');
    if (!target) throw new GatewayError('No writable task source configured', 503);
    const task = await target.writeTask(data);
    if (!task) throw new GatewayError('Task creation returned nothing', 502);
    return { source: target.source, task };
  }

  /** Update a task in its own source: vikunja (REST) or dayGLANCE (its MCP).
   *  lastGLANCE and lifeGLANCE data is owned by those apps and is read-only here. */
  async updateTask(source, id, patch) {
    const target = this.#adapters.get(source);
    if (!target) throw new GatewayError(`Unknown or disabled source ${source}`, 404);
    if (typeof target.updateTask !== 'function') {
      throw new GatewayError(source === 'dayglance'
        ? 'dayGLANCE tasks cannot be updated right now'
        : `${source} data is read-only here (change it in the ${source} app)`, 501);
    }
    return { source, task: await target.updateTask(id, patch) };
  }

  /**
   * Tools that adapters discover at runtime (e.g. vikunja's native MCP tools).
   * Never throws: a failing adapter simply contributes nothing.
   */
  async dynamicMcpTools() {
    const out = [];
    for (const adapter of this.adapters()) {
      if (typeof adapter.dynamicTools !== 'function') continue;
      try {
        out.push(...(await adapter.dynamicTools()));
      } catch {
        // adapter's dynamic tools unavailable
      }
    }
    return out;
  }

  /** Fetch the family roster (dayGLANCE primary, vikunja secondary). */
  async refreshRoster() {
    const day = this.#adapters.get('dayglance');
    if (day) await day.refreshRoster?.();
    const vik = this.#adapters.get('vikunja');
    if (vik) await vik.refreshRoster?.();
    return this.roster.list();
  }

  /**
   * Tasks across Vikunja and dayGLANCE, filtered and compacted for an agent.
   * due_on_or_before / due_on_or_after are inclusive; undated tasks are excluded
   * when either is set.
   */
  async listTasks({ status = 'open', source, owner_id = null, due_on_or_before, due_on_or_after, limit = 50 } = {}) {
    const { by, unavailable } = await this.readTasksDetailed(owner_id);
    let all = ['vikunja', 'dayglance'].flatMap((s) => by[s] ?? []);
    if (source) all = all.filter((t) => t.source === source);
    if (status === 'open') all = all.filter((t) => !t.completed);
    else if (status === 'done') all = all.filter((t) => t.completed);
    if (due_on_or_before) all = all.filter((t) => t.due_date && t.due_date <= due_on_or_before);
    if (due_on_or_after) all = all.filter((t) => t.due_date && t.due_date >= due_on_or_after);
    all.sort(byDue);
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      total: all.length, returned: Math.min(n, all.length), truncated: all.length > n, tasks: all.slice(0, n).map(compactTask),
      ...unavailableNote(unavailable.filter((u) => ['vikunja', 'dayglance'].includes(u) && (!source || u === source))),
    };
  }

  /** One day: dayGLANCE blocks in time order + open tasks due that day + overdue count. */
  async getDay(date, owner = null) {
    let blocks = [];
    let blocksFailed = false;
    try { blocks = await this.readBlocks(date, owner); } catch { blocksFailed = true; }
    const { by, unavailable } = await this.readTasksDetailed(owner);
    if (blocksFailed && !unavailable.includes('dayglance') && this.has('dayglance')) unavailable.push('dayglance');
    const all = ['vikunja', 'dayglance'].flatMap((s) => by[s] ?? []);
    const inBlocks = new Set(blocks.map((b) => String(b.id)));
    const tasks = all.filter((t) => !t.completed && t.due_date === date && !inBlocks.has(String(t.id)));
    const overdue = all.filter((t) => !t.completed && t.due_date && t.due_date < date).length;
    tasks.sort(byDue);
    const ordered = [...blocks].sort((a, b) => String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
    return {
      date, blocks: ordered.map(compactBlock), tasks: tasks.map(compactTask), overdue_count: overdue,
      ...unavailableNote(unavailable.filter((u) => ['vikunja', 'dayglance'].includes(u))),
    };
  }

  async listChores({ overdue_only = false, owner_id = null, limit = 50 } = {}) {
    let chores = await this.readChores(owner_id);
    if (overdue_only) chores = chores.filter((c) => c.overdue === true);
    chores = [...chores].sort((a, b) => (b.overdue === true) - (a.overdue === true) || String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9')));
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return { total: chores.length, returned: Math.min(n, chores.length), truncated: chores.length > n, chores: chores.slice(0, n).map(compactChore) };
  }

  async listMilestones({ from, to, limit = 50 } = {}) {
    let ms = await this.readMilestones();
    if (from) ms = ms.filter((m) => m.date && m.date >= from);
    if (to) ms = ms.filter((m) => m.date && m.date <= to);
    ms = [...ms].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return { total: ms.length, returned: Math.min(n, ms.length), truncated: ms.length > n, milestones: ms.slice(0, n).map(compactMilestone) };
  }

  /**
   * The MCP tool surface (see mcp/tools.js). The per-adapter vikunja_* tools are
   * intentionally NOT included: allglance_* covers them, and two overlapping
   * tool sets make agents pick worse. Their REST routes remain.
   */
  registerMcpTools() {
    return buildTools(this);
  }

  /** Register REST routes under the gateway base path. */
  registerRoutes(app, basePath = '/api/allglance') {
    const routes = [];

    app.get(`${basePath}/users`, async (req, res) => {
      try {
        const users = await this.refreshRoster();
        res.json({ users });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/users');

    app.get(`${basePath}/tasks`, async (req, res) => {
      try {
        const tasks = await this.readTasks(req.query.owner ?? null);
        res.json(tasks);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/tasks');

    app.get(`${basePath}/days/:date`, async (req, res) => {
      try {
        const date = req.params.date;
        const blocks = await this.readBlocks(date, req.query.owner ?? null);
        const all = await this.readTasks(req.query.owner ?? null);
        // "for that date": only tasks due/scheduled that day, per source.
        const tasks = Object.fromEntries(Object.entries(all).map(([src, list]) => [src, list.filter((t) => t.due_date === date)]));
        res.json({ date, blocks, tasks });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/days/:date');

    app.post(`${basePath}/tasks`, async (req, res) => {
      try {
        const result = await this.createTask(req.body ?? {});
        res.status(201).json(result);
      } catch (err) {
        res.status(err.status ?? 502).json({ error: err.message });
      }
    });
    routes.push('/tasks (POST)');

    app.get(`${basePath}/chores`, async (req, res) => {
      try {
        const chores = await this.readChores(req.query.owner ?? null);
        res.json({ chores });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/chores');

    app.get(`${basePath}/milestones`, async (req, res) => {
      try {
        const milestones = await this.readMilestones(req.query.owner ?? null);
        res.json({ milestones });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/milestones');

    // Update one task where it lives: PATCH /api/allglance/tasks/:source/:id
    // with any of { done, priority (0-5), title, due_date }.
    if (typeof app.patch === 'function') {
      app.patch(`${basePath}/tasks/:source/:id`, async (req, res) => {
        try {
          res.json(await this.updateTask(req.params.source, req.params.id, req.body ?? {}));
        } catch (err) {
          res.status(err.status ?? 502).json({ error: err.message });
        }
      });
      routes.push('/tasks/:source/:id (PATCH)');
    }

    // Adapters register paths like '/vikunja/tasks'; mount them under basePath
    // so they live at /api/allglance/vikunja/tasks as documented.
    const prefixed = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete']
      .filter((m) => typeof app[m] === 'function')
      .map((m) => [m, (path, ...handlers) => app[m](`${basePath}${path}`, ...handlers)]));
    for (const adapter of this.adapters()) {
      try {
        const sub = adapter.registerRoutes(prefixed);
        for (const r of sub) routes.push(r);
      } catch {
        // adapter has no routes
      }
    }

    return routes;
  }

  /** Health report across all enabled adapters. */
  async health() {
    const data = {};
    for (const [name, adapter] of this.#adapters) {
      try {
        data[name] = await adapter.status();
      } catch (err) {
        data[name] = { ok: false, error: err.message };
      }
    }
    return { adapters: data, roster: this.roster.list() };
  }
}

export { GatewayError };
export default Gateway;
