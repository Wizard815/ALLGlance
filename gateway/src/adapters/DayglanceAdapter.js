// dayGLANCE adapter — the multi-user family hub (DESIGN.md §4.2).
//
// dayGLANCE is the authoritative source for the family roster: its
// users[] + meUserSyncId define "who is who". Task/blocks data is obtained two
// ways:
//
//   PRIMARY (desktop): dayGLANCE's Electron MCP on loopback :7893 exposes real
//     MCP tools — dayglance_ping, dayglance_get_today, dayglance_get_day,
//     dayglance_list_unscheduled_tasks, dayglance_list_users,
//     dayglance_get_goal_progress, and write tools. We speak Streamable-HTTP
//     MCP with the bearer token dayGLANCE gates it with.
//
//   FALLBACK (Docker web, no MCP): a Playwright reader launches the app,
//     reads localStorage, and maps users[] + meUserSyncId onto the roster.
//
// OWNERSHIP LIMITATION (documented): dayGLANCE's MCP read blocks do NOT carry
// the assignee — only `dayglance_list_users` returns { id, name }. So owner_id
// is null for MCP-read tasks/blocks; per-user scoping is therefore a no-op over
// MCP and returns the full family day. Ownership IS preserved over the
// localStorage/desktop path, where readTasks(owner) / readBlocks(owner) filter
// correctly. The roster itself (list_users) still populates the family roster
// in both paths.
//
// The old client called dayglance_roster / dayglance_list_tasks /
// dayglance_list_blocks, which do NOT exist in dayGLANCE — those calls were a
// silent 401. Use the real tools above.

import { BaseAdapter } from './BaseAdapter.js';
import { taskOf } from '../model.js';
import LocalStorageReader from '../transport/LocalStorageReader.js';

export class DayglanceAdapter extends BaseAdapter {
  source = 'dayglance';
  label = 'dayGLANCE';

  #roster;
  #transport;
  #reader;
  #mode; // 'mcp' | 'playwright'

  constructor(opts) {
    super(opts);
    this.enabled = opts.config.dayglance.enabled;
    this.#roster = opts.roster;
    this.#mode = opts.mode ?? 'playwright';
    this.#reader = opts.reader ?? new LocalStorageReader({
      webUrl: opts.config.dayglance.webUrl,
      headless: opts.config.playwright.headless,
      timeoutMs: opts.config.playwright.timeoutMs,
    });
  }

  /** Inject the runtime transport (MCP client or Playwright reader). */
  setTransport(transport, mode = 'playwright') {
    this.#transport = transport;
    this.#mode = mode;
    return this;
  }

  /**
   * Build a roster from dayGLANCE's native multi-user config.
   * @param {{users: Array<object>, meUserSyncId: string|null}} native
   */
  #syncRoster(native) {
    if (native?.users?.length) this.#roster.addDayglance(native);
  }

  /**
   * Read dayGLANCE tasks/blocks from a native localStorage state blob
   * (fallback/Playwright path) OR an MCP result (desktop path).
   * @param {{tasks?: Array<object>, blocks?: Array<object>, users?: Array<object>, meUserSyncId?: string|null}} state
   */
  #normalize(state = {}) {
    this.#syncRoster(state);
    const ownerFor = (ids) => {
      const list = Array.isArray(ids) ? ids : [];
      return list.length ? String(list[0]) : null;
    };
    const tasks = [];
    const blocks = [];
    for (const t of state.tasks ?? []) {
      const ownerId = ownerFor(t.assignedUserSyncIds ?? []);
      tasks.push(taskOf('dayglance', t, ownerId));
      blocks.push({ ...t, owner_id: ownerId });
    }
    return { tasks, blocks };
  }

  /**
   * Parse dayGLANCE localStorage keys into the state blob #normalize expects.
   * @param {Record<string, string>} store — raw localStorage { key: value }
   */
  #fromLocalStorage(store = {}) {
    const tasks = [];
    for (const key of ['day-planner-tasks', 'day-planner-unscheduled']) {
      try {
        const parsed = JSON.parse(store[key] ?? '[]');
        for (const t of Array.isArray(parsed) ? parsed : []) {
          if (t && t.id != null) tasks.push(t);
        }
      } catch {
        // ignore unparseable task arrays
      }
    }

    const users = [];
    for (const key of ['dayglance-users', 'dayglance-multi-user-config']) {
      try {
        const parsed = JSON.parse(store[key] ?? '[]');
        if (Array.isArray(parsed)) users.push(...parsed);
        else if (parsed && Array.isArray(parsed.users)) users.push(...parsed.users);
      } catch {
        // ignore unparseable user arrays
      }
    }

    let meUserSyncId = null;
    try {
      const parsed = JSON.parse(store['dayglance-multi-user-config'] ?? '{}');
      meUserSyncId = parsed?.meUserSyncId ?? null;
    } catch {
      // meUserSyncId stays null
    }

    return { tasks, blocks: [], users, meUserSyncId };
  }

  /**
   * Public entry the server uses to wire the Playwright fallback transport:
   * reads dayGLANCE's browser localStorage and returns the parsed state blob
   * (no #normalize applied — the server sets #transport, and #read() normalizes).
   */
  async readLocalStorage() {
    return this.#fromLocalStorage(
      await this.#reader.read({ webUrl: this.config.dayglance.webUrl })
    );
  }

  /**
   * Resolve the live task/block snapshot. Prefers the injected MCP transport
   * (dayGLANCE desktop build); otherwise reads the browser localStorage via
   * Playwright and normalizes it through #normalize so owner_id and the roster
   * are populated the same way in both paths.
   *
   * MCP reads are date-scoped (dayGLANCE exposes get_today / get_day), so the
   * adapter passes `date` through to the transport. `today` is accepted as a
   * shorthand for the current local calendar date.
   *
   * @param {string} date  'today' or a local YYYY-MM-DD calendar date.
   */
  async #read(date = 'today') {
    if (this.#transport && typeof this.#transport.read === 'function') {
      return this.#normalize(await this.#transport.read(date));
    }
    return this.#normalize(this.#fromLocalStorage(await this.#reader.read()));
  }

  async readTasks(owner = null) {
    const { tasks } = await this.#read('today');
    return { tasks: owner ? tasks.filter((t) => t.owner_id === owner) : tasks };
  }

  async readBlocks(date = null, owner = null) {
    const target = date && date !== 'today' ? date : 'today';
    const { blocks } = await this.#read(target);
    const scoped = owner ? blocks.filter((b) => b.owner_id === owner) : blocks;
    const forDate = date ? scoped.filter((b) => b.date === date) : scoped;
    return { blocks: forDate };
  }

  async readChores(owner = null) {
    return await this.readTasks(owner);
  }

  async refreshRoster() {
    // Roster is synced on the first read in both transport paths.
    return this.#roster.list();
  }

  async status() {
    try {
      await this.#read();
      return { ok: true, label: this.label, mode: this.#mode, roster: this.#roster.size };
    } catch (err) {
      return { ok: false, error: err.message, mode: this.#mode };
    }
  }
}

export default DayglanceAdapter;
