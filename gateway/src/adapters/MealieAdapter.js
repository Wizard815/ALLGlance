// Mealie: the family's meal plan, added to allglance_get_day so an agent that only uses
// ALLGlance still knows what's for dinner. Read-only, and the meal plan is household-wide
// (nobody's private things), so every caller gets it.
//
// Mealie's API with an API token (Mealie: your profile -> API Tokens). Newer Mealie keeps the
// plan per household (/api/households/mealplans); older releases per group
// (/api/groups/mealplans). The adapter tries the first and falls back to the second once.

import { BaseAdapter } from './BaseAdapter.js';
import { fetchJson } from '../lib/fetch.js';

const ORDER = ['breakfast', 'lunch', 'dinner', 'side', 'snack'];

export class MealieAdapter extends BaseAdapter {
  source = 'mealie';
  label = 'Mealie';
  #url;
  #token;
  #path = '/api/households/mealplans';

  constructor(opts) {
    super(opts);
    const cfg = opts.config.mealie ?? {};
    this.#url = String(cfg.url ?? '').replace(/\/+$/, '');
    this.#token = cfg.token ?? '';
    this.enabled = Boolean(cfg.enabled) && Boolean(this.#url) && Boolean(this.#token);
  }

  async status() {
    try { await this.mealsFor(new Date().toISOString().slice(0, 10)); return true; } catch { return false; }
  }

  async #get(path, date) {
    const q = new URLSearchParams({ start_date: date, end_date: date, page: '1', perPage: '-1' });
    return fetchJson(`${this.#url}${path}?${q}`, { headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' }, timeoutMs: 10000 });
  }

  /** That day's meals: [{ type: 'dinner', title, recipe? }], breakfast to snack. Throws when Mealie can't be reached. */
  async mealsFor(date) {
    let out;
    try { out = await this.#get(this.#path, date); }
    catch (e) {
      if (this.#path !== '/api/groups/mealplans' && /-> 404/.test(e.message)) { this.#path = '/api/groups/mealplans'; out = await this.#get(this.#path, date); }
      else throw e;
    }
    const items = Array.isArray(out) ? out : out?.items ?? [];
    return items
      .filter((m) => String(m.date ?? '').slice(0, 10) === date)
      .map((m) => ({
        type: String(m.entryType ?? m.entry_type ?? 'dinner'),
        title: String(m.recipe?.name ?? m.title ?? '').trim() || 'Untitled',
        ...(m.recipe?.slug ? { recipe: m.recipe.slug } : {}),
        ...(m.text && !m.recipe ? { note: String(m.text).slice(0, 200) } : {}),
      }))
      .sort((a, b) => (ORDER.indexOf(a.type) + 99) % 99 - (ORDER.indexOf(b.type) + 99) % 99);
  }
}
