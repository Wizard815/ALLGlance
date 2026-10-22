// Orchestrator — wires all enabled adapters into one unified task/calendar API.
// Handles the unification layer (DESIGN.md §5), per-user scoping via the roster,
// and delegates MCP tool + REST route registration to each adapter.

import { Roster } from './identity/roster.js';
import config from './config.js';
import { VikunjaAdapter } from './adapters/VikunjaAdapter.js';
import { DayglanceAdapter } from './adapters/DayglanceAdapter.js';
import { LastglanceAdapter } from './adapters/LastglanceAdapter.js';
import { LifeglanceAdapter } from './adapters/LifeglanceAdapter.js';

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
    const out = { vikunja: [], dayglance: [], lastglance: [], lifeglance: [] };
    for (const a of this.adapters()) {
      try {
        const { tasks } = await a.readTasks(owner);
        out[a.source] = tasks;
      } catch {
        // Skip adapters that fail (e.g. network down) rather than aborting.
      }
    }
    return out;
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

  /** Fetch the family roster (dayGLANCE primary, vikunja secondary). */
  async refreshRoster() {
    const day = this.#adapters.get('dayglance');
    if (day) await day.refreshRoster?.();
    const vik = this.#adapters.get('vikunja');
    if (vik) await vik.refreshRoster?.();
    return this.roster.list();
  }

  /** Register MCP tools on the given server instance. */
  registerMcpTools(server) {
    const builtins = [
      {
        name: 'allglance_list_tasks',
        description: 'List tasks across all sources. Optional owner_id scopes to one family member.',
        inputSchema: {
          type: 'object',
          properties: { owner_id: { type: 'string' } },
        },
        handler: async (args) => {
          const tasks = await this.readTasks(args?.owner_id ?? null);
          return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
        },
      },
      {
        name: 'allglance_list_days',
        description: 'Read a day time blocks + tasks for one date.',
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: "YYYY-MM-DD" },
            owner_id: { type: 'string' },
          },
          required: ['date'],
        },
        handler: async (args) => {
          const blocks = await this.readBlocks(args.date, args?.owner_id ?? null);
          const tasks = await this.readTasks(args?.owner_id ?? null);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ date: args.date, blocks, tasks }, null, 2),
              },
            ],
          };
        },
      },
      {
        name: 'allglance_list_users',
        description: 'List the family roster (who is who).',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const users = await this.refreshRoster();
          return { content: [{ type: 'text', text: JSON.stringify({ users }, null, 2) }] };
        },
      },
      {
        name: 'allglance_create_task',
        description: 'Create a task in the default source (vikunja) or a specified one.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            due_date: { type: 'string' },
            owner_id: { type: 'string' },
            project_id: { type: 'integer' },
          },
          required: ['title'],
        },
        handler: async (args) => {
          const result = await this.createTask(args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
      },
    ];

    const registered = [...builtins];
    for (const adapter of this.adapters()) {
      try {
        const extra = adapter.registerTools(server);
        for (const t of extra) registered.push(t);
      } catch {
        // adapter has no tools to register
      }
    }
    return registered;
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
        const blocks = await this.readBlocks(req.params.date, req.query.owner ?? null);
        const tasks = await this.readTasks(req.query.owner ?? null);
        res.json({ date: req.params.date, blocks, tasks });
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

    for (const adapter of this.adapters()) {
      try {
        const sub = adapter.registerRoutes(app);
        for (const r of sub) routes.push(`/${adapter.source}${r}`);
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
