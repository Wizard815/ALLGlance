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

  async readChores(owner = null) {
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
