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
import { Roster } from '../identity/roster.js';
import LocalStorageReader from '../transport/LocalStorageReader.js';
import config from '../config.js';

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
    // dayGLANCE's own state uses assignedUserSyncIds[]; its MCP read model
    // (get_day / list_unscheduled_tasks) reports a single assignee_id instead.
    const ownerFor = (ids, single) => {
      const list = Array.isArray(ids) ? ids : [];
      if (list.length) return String(list[0]);
      return single != null && single !== '' ? String(single) : null;
    };
    const tasks = [];
    const blocks = [];
    for (const t of state.tasks ?? []) {
      const ownerId = ownerFor(t.assignedUserSyncIds, t.assignee_id);
      tasks.push(taskOf('dayglance', t, ownerId));
      blocks.push({ ...t, owner_id: ownerId });
    }
    // MCP transport: scheduled day items arrive as `blocks` (the inbox arrives
    // as `tasks`). Carry them through, and surface scheduled task blocks as
    // tasks, like the localStorage path does for every scheduled task.
    const seen = new Set(tasks.map((t) => t.id));
    const seenBlocks = new Set(blocks.map((b) => String(b.id)));
    for (const b of state.blocks ?? []) {
      if (seenBlocks.has(String(b.id))) continue; // already carried via tasks
      seenBlocks.add(String(b.id));
      const ownerId = ownerFor(b.assignedUserSyncIds, b.assignee_id);
      blocks.push({ ...b, owner_id: ownerId });
      if (b.type === 'task') {
        const task = taskOf('dayglance', b, ownerId);
        if (!seen.has(task.id)) {
          seen.add(task.id);
          tasks.push(task);
        }
      }
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

  #call(name, args) {
    if (!this.#transport || typeof this.#transport.call !== 'function') {
      throw new Error('dayGLANCE writes need its MCP transport (dayglance-mcp is not reachable)');
    }
    return this.#transport.call(name, args).catch((err) => {
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? ?out|aborted/i.test(`${err.message} ${err.cause?.code ?? ''}`)) {
        throw new Error('dayGLANCE is temporarily unreachable (its MCP service is not responding). The task was not changed; try again shortly.');
      }
      throw err;
    });
  }

  /**
   * Create a dayGLANCE task through its MCP. With `start` ("YYYY-MM-DD HH:MM", or
   * "YYYY-MM-DD" with all_day) it is placed on the calendar; without, it lands in
   * the inbox (optionally with a due_date as its deadline). dayGLANCE priority is
   * 0-3, so higher values are capped.
   */
  async writeTask({ title, start, due_date, duration_minutes, all_day, priority, notes } = {}) {
    const args = { title };
    if (notes) args.notes = notes;
    // dayGLANCE keeps priority and deadline on INBOX tasks only; a scheduled task
    // (with start) that carries them is rejected, so they are left off then.
    if (priority !== undefined && !start) args.priority = Math.max(0, Math.min(3, Math.round(Number(priority) || 0)));
    if (start) {
      args.start = start;
      if (duration_minutes) args.duration_minutes = duration_minutes;
      if (all_day) args.all_day = true;
    } else if (due_date) {
      args.deadline = due_date;
    }
    const res = await this.#call('dayglance_create_task', args);
    const raw = res.task ?? res.block ?? res;
    return taskOf('dayglance', raw, null, title);
  }

  /**
   * Update a dayGLANCE task: done, title, priority, notes, due_date (inbox
   * deadline; null clears it) and/or start (move it onto the calendar).
   */
  async updateTask(id, patch = {}) {
    const taskId = String(id);
    let last = null;
    const edit = {};
    if (patch.title !== undefined) edit.title = String(patch.title);
    if (patch.notes !== undefined) edit.notes = String(patch.notes);
    if (patch.priority !== undefined) edit.priority = Math.max(0, Math.min(3, Math.round(Number(patch.priority) || 0)));
    if (patch.due_date !== undefined) {
      if (patch.due_date) edit.deadline = patch.due_date;
      else edit.clear_fields = ['deadline'];
    }
    if (Object.keys(edit).length) last = await this.#call('dayglance_update_task', { task_id: taskId, ...edit });
    if (patch.start) {
      last = await this.#call('dayglance_schedule_task', {
        task_id: taskId,
        start: patch.start,
        ...(patch.duration_minutes ? { duration_minutes: patch.duration_minutes } : {}),
      });
    }
    if (patch.done !== undefined) {
      last = await this.#call('dayglance_set_task_completion', { task_id: taskId, completed: Boolean(patch.done) });
    }
    if (!last) throw new Error('nothing to update');
    const raw = last.task ?? last.block ?? last;
    return taskOf('dayglance', { id: taskId, ...raw }, null);
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
