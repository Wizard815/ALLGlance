// Orchestrator — wires all enabled adapters into one unified task/calendar API.
// Handles the unification layer (DESIGN.md §5), per-user scoping via the roster,
// and delegates MCP tool + REST route registration to each adapter.
//
// Access: every read and write takes the caller's scope (src/access.js) and drops or
// refuses what that scope may not see. Callers use gateway.as(scope), which binds it;
// leaving the scope out means admin (in-process callers and tests).

import { buildTools } from './mcp/tools.js';
import { compactTask, compactBlock, compactChore, compactMilestone, byDue } from './mcp/format.js';
import { Roster } from './identity/roster.js';
import config from './config.js';
import { VikunjaAdapter } from './adapters/VikunjaAdapter.js';
import { DayglanceAdapter } from './adapters/DayglanceAdapter.js';
import { LastglanceAdapter } from './adapters/LastglanceAdapter.js';
import { LifeglanceAdapter } from './adapters/LifeglanceAdapter.js';
import { OmiAdapter } from './adapters/OmiAdapter.js';
import { ADMIN, policyFrom, canSee, omiAllowed, toolRefusal, whoami } from './access.js';

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
    this.policy = policyFrom(config.access);
    this.#loadAdapters();
  }

  /** Drop the items `scope` may not see. */
  #visible(items, source, scope) {
    if (scope.kind === 'admin') return items;
    return items.filter((item) => canSee(scope, item, item?.source ?? source, this.policy));
  }

  #loadAdapters() {
    // Eagerly wired so adapters are registered synchronously with `new Gateway()`.
    const registry = [
      ['vikunja', VikunjaAdapter],
      ['dayglance', DayglanceAdapter],
      ['lastglance', LastglanceAdapter],
      ['lifeglance', LifeglanceAdapter],
      ['omi', OmiAdapter],
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

  /** One enabled adapter by source name, or undefined. */
  adapter(name) {
    return this.#adapters.get(name);
  }

  /** Read tasks across all sources, optionally scoped to an owner. */
  async readTasks(owner = null, scope = ADMIN) {
    return (await this.readTasksDetailed(owner, scope)).by;
  }

  /**
   * Like readTasks, but also says which sources could not be read (network down,
   * bad credentials...). One failing source never aborts the rest, but callers
   * that answer an agent must not present a partial answer as the whole one.
   * @returns {Promise<{ by: Record<string, object[]>, unavailable: string[] }>}
   */
  async readTasksDetailed(owner = null, scope = ADMIN) {
    const by = { vikunja: [], dayglance: [], lastglance: [], lifeglance: [] };
    const unavailable = [];
    for (const a of this.adapters()) {
      try {
        const { tasks } = await a.readTasks(owner);
        by[a.source] = this.#visible(tasks ?? [], a.source, scope);
      } catch {
        unavailable.push(a.source);
      }
    }
    return { by, unavailable };
  }

  /** Read the day's time blocks (dayGLANCE) for one date, optionally scoped. */
  async readBlocks(date, owner = null, scope = ADMIN) {
    const adapter = this.#adapters.get('dayglance');
    if (!adapter) return [];
    const res = await adapter.readBlocks(date, owner);
    return this.#visible(res.blocks ?? [], 'dayglance', scope);
  }

  /** Read milestones (lifeGLANCE), optionally scoped. */
  async readMilestones(owner = null, scope = ADMIN) {
    const adapter = this.#adapters.get('lifeglance');
    if (!adapter) return [];
    return this.#visible((await adapter.readMilestones(owner)).milestones ?? [], 'lifeglance', scope);
  }

  /** Read recent chores (lastGLANCE), optionally scoped. */
  async readChores(owner = null, scope = ADMIN) {
    const adapter = this.#adapters.get('lastglance');
    if (!adapter) return [];
    return this.#visible((await adapter.readChores(owner)).chores ?? [], 'lastglance', scope);
  }

  /**
   * Create a task through the first writable source. Returns { source, task }.
   * @param {object} data
   */
  async createTask(data, scope = ADMIN) {
    const target = data.source ? this.#adapters.get(data.source) : this.#adapters.get('vikunja');
    if (!target) throw new GatewayError('No writable task source configured', 503);
    // A person's own agent creates tasks for that person unless it names someone else.
    if (scope.kind === 'person' && (data.owner_id === undefined || data.owner_id === null || data.owner_id === '')) {
      data = { ...data, owner_id: this.#personIdFor(scope, target.source) };
    }
    let task;
    try {
      task = await target.writeTask(data);
    } catch (err) {
      // The project list can name someone's private project; only admin gets it.
      if (scope.kind !== 'admin' && /^No Vikunja project named/.test(err.message)) throw new GatewayError(err.message.replace(/\. Projects: .*$/s, '.'), 400);
      throw err;
    }
    if (!task) throw new GatewayError('Task creation returned nothing', 502);
    return { source: target.source, task };
  }

  /** Which of a person token's ids an app knows them by: Vikunja ids are numbers, dayGLANCE's are not. */
  #personIdFor(scope, source) {
    const known = scope.ids.find((id) => this.roster.get(id)?.source === source);
    if (known) return known;
    const numeric = scope.ids.find((id) => /^\d+$/.test(id));
    if (source === 'vikunja') return numeric ?? scope.owner_id;
    return scope.ids.find((id) => !/^\d+$/.test(id)) ?? scope.owner_id;
  }

  /** Update a task in its own source: vikunja (REST) or dayGLANCE (its MCP).
   *  lastGLANCE and lifeGLANCE data is owned by those apps and is read-only here.
   *  A scoped caller may not change a private task that is not theirs. */
  async updateTask(source, id, patch, scope = ADMIN) {
    const target = this.#adapters.get(source);
    if (!target) throw new GatewayError(`Unknown or disabled source ${source}`, 404);
    if (typeof target.updateTask !== 'function') {
      throw new GatewayError(source === 'dayglance'
        ? 'dayGLANCE tasks cannot be updated right now'
        : `${source} data is read-only here (change it in the ${source} app)`, 501);
    }
    if (scope.kind !== 'admin') {
      const current = typeof target.readTask === 'function'
        ? await target.readTask(id)
        : ((await target.readTasks()).tasks ?? []).find((t) => String(t.id) === String(id));
      if (!current) throw new GatewayError(`Could not find ${source} task ${id} to check whose it is, so it was not changed.`, 404);
      if (!canSee(scope, current, source, this.policy)) {
        throw new GatewayError(`${source} task ${id} is someone else's private task; this token cannot change it. Nothing was changed.`, 403);
      }
    }
    return { source, task: await target.updateTask(id, patch) };
  }

  /**
   * Tools that adapters discover at runtime (e.g. vikunja's native MCP tools).
   * Never throws: a failing adapter simply contributes nothing.
   */
  async dynamicMcpTools(scope = ADMIN) {
    const out = [];
    for (const adapter of this.adapters()) {
      if (typeof adapter.dynamicTools !== 'function') continue;
      try {
        out.push(...(await adapter.dynamicTools()));
      } catch {
        // adapter's dynamic tools unavailable
      }
    }
    return out.filter((t) => !toolRefusal(scope, t.name, this.policy));
  }

  /** Why `scope` may not call tool `name`, or null. */
  toolRefusal(name, scope = ADMIN) {
    return toolRefusal(scope, name, this.policy);
  }

  /** The caller's scope, for GET /whoami and allglance_whoami. */
  whoami(scope = ADMIN) {
    return whoami(scope, this.policy, { omiEnabled: this.has('omi') });
  }

  /**
   * This gateway as seen by one caller: the methods the REST routes and MCP tools use,
   * with the caller's scope bound. The one place access rules reach every surface.
   */
  as(scope = ADMIN) {
    const s = scope?.kind ? scope : ADMIN;
    return {
      scope: s,
      roster: this.roster,
      has: (name) => this.has(name),
      refreshRoster: () => this.refreshRoster(),
      readTasks: (owner) => this.readTasks(owner, s),
      readBlocks: (date, owner) => this.readBlocks(date, owner, s),
      readChores: (owner) => this.readChores(owner, s),
      readMilestones: (owner) => this.readMilestones(owner, s),
      listTasks: (args) => this.listTasks(args, s),
      getDay: (date, owner) => this.getDay(date, owner, s),
      listChores: (args) => this.listChores(args, s),
      listMilestones: (args) => this.listMilestones(args, s),
      createTask: (data) => this.createTask(data, s),
      updateTask: (source, id, patch) => this.updateTask(source, id, patch, s),
      dynamicMcpTools: () => this.dynamicMcpTools(s),
      toolRefusal: (name) => this.toolRefusal(name, s),
      whoami: () => this.whoami(s),
    };
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
  async listTasks({ status = 'open', source, owner_id = null, due_on_or_before, due_on_or_after, limit = 50 } = {}, scope = ADMIN) {
    const { by, unavailable } = await this.readTasksDetailed(owner_id, scope);
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
  async getDay(date, owner = null, scope = ADMIN) {
    let blocks = [];
    let blocksFailed = false;
    try { blocks = await this.readBlocks(date, owner, scope); } catch { blocksFailed = true; }
    const { by, unavailable } = await this.readTasksDetailed(owner, scope);
    if (blocksFailed && !unavailable.includes('dayglance') && this.has('dayglance')) unavailable.push('dayglance');
    const all = ['vikunja', 'dayglance'].flatMap((s) => by[s] ?? []);
    const inBlocks = new Set(blocks.map((b) => String(b.id)));
    const tasks = all.filter((t) => !t.completed && t.due_date === date && !inBlocks.has(String(t.id)));
    const overdue = all.filter((t) => !t.completed && t.due_date && t.due_date < date).length;
    tasks.sort(byDue);
    const ordered = [...blocks].sort((a, b) => String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
    // Omi's day bundle, when the wearable is wired in: the day in words next to the day in tasks.
    // It is one person's day, so only callers who may use Omi get it.
    let omi;
    const omiAdapter = omiAllowed(scope, this.policy) ? this.adapter('omi') : undefined;
    if (omiAdapter) {
      try { omi = await omiAdapter.daySummary(date); } catch { unavailable.push('omi'); }
    }
    return {
      date, blocks: ordered.map(compactBlock), tasks: tasks.map(compactTask), overdue_count: overdue,
      ...(omiAdapter ? { omi_day_summary: omi ?? null } : {}),
      ...unavailableNote(unavailable.filter((u) => ['vikunja', 'dayglance', 'omi'].includes(u))),
    };
  }

  async listChores({ overdue_only = false, owner_id = null, limit = 50 } = {}, scope = ADMIN) {
    let chores = await this.readChores(owner_id, scope);
    if (overdue_only) chores = chores.filter((c) => c.overdue === true);
    chores = [...chores].sort((a, b) => (b.overdue === true) - (a.overdue === true) || String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9')));
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return { total: chores.length, returned: Math.min(n, chores.length), truncated: chores.length > n, chores: chores.slice(0, n).map(compactChore) };
  }

  async listMilestones({ from, to, limit = 50 } = {}, scope = ADMIN) {
    let ms = await this.readMilestones(null, scope);
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
  registerMcpTools(scope = ADMIN) {
    return buildTools(this.as(scope));
  }

  /** Register REST routes under the gateway base path. Each handler reads as the caller
   *  (req.scope, set by the access middleware in server.js; admin when absent). */
  registerRoutes(app, basePath = '/api/allglance') {
    const routes = [];
    const as = (req) => this.as(req.scope ?? ADMIN);

    app.get(`${basePath}/whoami`, (req, res) => {
      res.json(as(req).whoami());
    });
    routes.push('/whoami');

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
        const tasks = await as(req).readTasks(req.query.owner ?? null);
        res.json(tasks);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/tasks');

    app.get(`${basePath}/days/:date`, async (req, res) => {
      try {
        const date = req.params.date;
        const gw = as(req);
        const blocks = await gw.readBlocks(date, req.query.owner ?? null);
        const all = await gw.readTasks(req.query.owner ?? null);
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
        const result = await as(req).createTask(req.body ?? {});
        res.status(201).json(result);
      } catch (err) {
        res.status(err.status ?? 502).json({ error: err.message });
      }
    });
    routes.push('/tasks (POST)');

    app.get(`${basePath}/chores`, async (req, res) => {
      try {
        const chores = await as(req).readChores(req.query.owner ?? null);
        res.json({ chores });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
    routes.push('/chores');

    app.get(`${basePath}/milestones`, async (req, res) => {
      try {
        const milestones = await as(req).readMilestones(req.query.owner ?? null);
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
          res.json(await as(req).updateTask(req.params.source, req.params.id, req.body ?? {}));
        } catch (err) {
          res.status(err.status ?? 502).json({ error: err.message });
        }
      });
      routes.push('/tasks/:source/:id (PATCH)');
    }

    // Adapters register paths like '/vikunja/tasks'; mount them under basePath
    // so they live at /api/allglance/vikunja/tasks as documented. They read the app
    // directly, without the privacy rules, so only the admin token may use them.
    const adminOnly = (req, res, next) => {
      if ((req.scope ?? ADMIN).kind === 'admin') return next();
      res.status(403).json({ error: `${req.path} reads the app directly and cannot hide private items, so only the admin token (GATEWAY_TOKEN) may use it. Use ${basePath}/tasks.` });
    };
    const prefixed = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete']
      .filter((m) => typeof app[m] === 'function')
      .map((m) => [m, (path, ...handlers) => app[m](`${basePath}${path}`, adminOnly, ...handlers)]));
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
