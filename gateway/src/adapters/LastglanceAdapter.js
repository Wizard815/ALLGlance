// lastGLANCE adapter — chore recency data (DESIGN.md §4.3).
//
// lastGLANCE stores chore history in localStorage. Its GLANCE-intents transport
// (src/intents/*) preserves ownership via assigned_user_sync_ids and
// completed_by_user_id on chore envelopes. This adapter reads localStorage
// (via the Playwright fallback) and normalizes chore records, mapping
// assigned_user_sync_ids -> owner_id.

import { BaseAdapter } from './BaseAdapter.js';
import { Roster } from '../identity/roster.js';
import LocalStorageReader from '../transport/LocalStorageReader.js';
import config from '../config.js';
import { readSnapshot } from '../lib/syncSnapshot.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class LastglanceAdapter extends BaseAdapter {
  source = 'lastglance';
  label = 'lastGLANCE';

  #roster;
  #reader;

  constructor(opts) {
    super(opts);
    this.enabled = opts.config.lastglance.enabled;
    this.#roster = opts.roster;
    this.#reader = new LocalStorageReader({
      webUrl: opts.config.lastglance.webUrl,
      headless: opts.config.playwright.headless,
      timeoutMs: opts.config.playwright.timeoutMs,
    });
  }

  /**
   * Chores from lastGLANCE's own synced snapshot (lastglance-sync.json):
   * { chores, categories, completionEvents, users }. lastGLANCE keeps its data in
   * IndexedDB, so the snapshot is the only server-readable copy.
   */
  async #readSnapshotChores(owner, now = Date.now()) {
    const snap = await readSnapshot({
      dir: this.config.sync.dir,
      filename: 'lastglance-sync.json',
      passphrase: this.config.sync.passphrase,
    });
    if (!snap) return null;
    const { chores = [], categories = [], completionEvents = [], users = [] } = snap.doc.data;
    for (const u of users) if (u?.id) this.#roster.set(String(u.id), u.name ?? 'Unknown', 'lastglance');
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const lastDone = new Map();
    for (const e of completionEvents) {
      const t = Date.parse(e.completedAt);
      if (!Number.isNaN(t) && t > (lastDone.get(e.choreSyncId) ?? 0)) lastDone.set(e.choreSyncId, t);
    }
    const out = chores.map((c) => {
      const assigned = Array.isArray(c.assignedUserSyncIds) ? c.assignedUserSyncIds : [];
      const last = lastDone.get(c.id) ?? null;
      const cadence = typeof c.targetCadenceDays === 'number' ? c.targetCadenceDays : null;
      const dueMs = last !== null && cadence !== null ? last + cadence * DAY_MS : null;
      return {
        source: 'lastglance',
        id: String(c.id),
        title: c.name ?? '(chore)',
        owner_id: assigned.length ? String(assigned[0]) : null,
        due_date: dueMs !== null ? new Date(dueMs).toISOString().slice(0, 10) : null,
        completed: false,
        last_completed: last !== null ? new Date(last).toISOString() : null,
        target_cadence_days: cadence,
        // Never-done chores count as overdue only when they have a cadence.
        overdue: cadence === null ? null : dueMs === null ? true : dueMs < now,
        category: catName.get(c.categorySyncId) ?? null,
        extra: c,
      };
    });
    return { chores: owner ? out.filter((c) => c.owner_id === owner) : out };
  }

  async readChores(owner = null) {
    if (this.config.sync?.dir) {
      const r = await this.#readSnapshotChores(owner);
      return r ?? { chores: [] }; // app has not synced yet: empty, never fabricated
    }
    const store = await this.#reader.read({ webUrl: this.config.lastglance.webUrl });
    const chores = [];
    const entries = store['lg-chores'] ?? store['lastglance-chores'] ?? {};
    for (const raw of Object.values(entries)) {
      try {
        const chore = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const assigned = Array.isArray(chore.assigned_user_sync_ids) ? chore.assigned_user_sync_ids : [];
        const ownerId = assigned.length ? String(assigned[0]) : null;
        this.#roster.set(ownerId, chore.owner_name ?? chore.assigned_user_name ?? chore.name ?? 'Unknown', 'lastglance');
        chores.push({
          source: 'lastglance',
          id: String(chore.id ?? chore.sync_id ?? null),
          title: chore.name ?? chore.title ?? '(chore)',
          owner_id: ownerId,
          due_date: null,
          completed: Boolean(chore.completed),
          last_completed: chore.last_completed_at ?? chore.completed_at ?? null,
          extra: chore,
        });
      } catch {
        // skip unparseable entries
      }
    }
    const scoped = owner ? chores.filter((c) => c.owner_id === owner) : chores;
    return { chores: scoped };
  }

  async status() {
    if (this.config.sync?.dir) {
      try {
        const r = await this.#readSnapshotChores(null);
        if (!r) return { ok: false, error: 'no lastglance-sync.json yet — enable Cloud Sync in lastGLANCE', label: this.label };
        return { ok: true, count: r.chores.length, label: this.label, mode: 'snapshot' };
      } catch (err) {
        return { ok: false, error: err.message, label: this.label };
      }
    }
    try {
      const store = await this.#reader.read({ webUrl: this.config.lastglance.webUrl });
      const count = Object.keys(store).length;
      return { ok: count > 0, count, label: this.label };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export default LastglanceAdapter;
