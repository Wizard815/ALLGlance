// lifeGLANCE adapter — milestone/timeline data (DESIGN.md §4.4).
//
// lifeGLANCE has no ownership model; milestones are a shared/family timeline.
// Data lives in localStorage under the PINS_KEY. We read it via the Playwright
// fallback and normalize milestones with owner_id = null.

import { BaseAdapter } from './BaseAdapter.js';
import LocalStorageReader from '../transport/LocalStorageReader.js';
import config from '../config.js';
import { readSnapshot } from '../lib/syncSnapshot.js';

export class LifeglanceAdapter extends BaseAdapter {
  source = 'lifeglance';
  label = 'lifeGLANCE';

  #reader;

  constructor(opts) {
    super(opts);
    this.enabled = opts.config.lifeglance.enabled;
    this.#reader = new LocalStorageReader({
      webUrl: opts.config.lifeglance.webUrl,
      headless: opts.config.playwright.headless,
      timeoutMs: opts.config.playwright.timeoutMs,
    });
  }

  /** Milestones from lifeGLANCE's own synced snapshot: data.lives.default.milestones. */
  async #readSnapshotMilestones() {
    const snap = await readSnapshot({
      dir: this.config.sync.dir,
      filename: 'lifeglance-sync.json',
      passphrase: this.config.sync.passphrase,
    });
    if (!snap) return null;
    const life = snap.doc.data.lives?.default ?? {};
    const milestones = (life.milestones ?? []).map((m) => ({
      source: 'lifeglance',
      id: String(m.id),
      title: m.title ?? '(milestone)',
      date: typeof m.date === 'string' ? m.date.slice(0, 10) : m.date ? new Date(m.date).toISOString().slice(0, 10) : null,
      date_precision: m.date_precision ?? null,
      category: m.category ?? null,
      note: m.note ?? '',
      owner_id: null,
      dayglance_linked: Boolean(m.dayglance_linked),
      dayglance_task_id: m.dayglance_task_id ?? null,
      extra: m,
    }));
    return { milestones, chapters: life.chapters ?? [] };
  }

  async readMilestones(owner = null) {
    if (this.config.sync?.dir) {
      const r = await this.#readSnapshotMilestones();
      return { milestones: r?.milestones ?? [] }; // not synced yet: empty, never fabricated
    }
    const store = await this.#reader.read({ webUrl: this.config.lifeglance.webUrl });
    const raw = store['lifeglance-pins'] ?? store['milestones'] ?? {};
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const milestones = Object.values(list ?? {}).map((m) => ({
      source: 'lifeglance',
      id: String(m.id ?? m.pinId ?? null),
      title: m.title ?? m.name ?? '(milestone)',
      date: m.date ?? m.when ?? null,
      owner_id: null,
      extra: m,
    }));
    return { milestones };
  }

  async status() {
    if (this.config.sync?.dir) {
      try {
        const r = await this.#readSnapshotMilestones();
        if (!r) return { ok: false, error: 'no lifeglance-sync.json yet — enable Cloud Sync in lifeGLANCE', label: this.label };
        return { ok: true, count: r.milestones.length, label: this.label, mode: 'snapshot' };
      } catch (err) {
        return { ok: false, error: err.message, label: this.label };
      }
    }
    try {
      const store = await this.#reader.read({ webUrl: this.config.lifeglance.webUrl });
      const count = Object.keys(store ?? {}).length;
      return { ok: count > 0, count, label: this.label };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export default LifeglanceAdapter;
