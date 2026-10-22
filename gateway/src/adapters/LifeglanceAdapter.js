// lifeGLANCE adapter — milestone/timeline data (DESIGN.md §4.4).
//
// lifeGLANCE has no ownership model; milestones are a shared/family timeline.
// Data lives in localStorage under the PINS_KEY. We read it via the Playwright
// fallback and normalize milestones with owner_id = null.

import { BaseAdapter } from './BaseAdapter.js';
import LocalStorageReader from '../transport/LocalStorageReader.js';

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

  async readMilestones(_owner = null) {  // lifeGLANCE has no ownership model
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
