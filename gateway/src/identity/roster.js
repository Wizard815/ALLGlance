// Identity layer — the normalized family roster (DESIGN.md §3).
//
// dayGLANCE owns the roster: users[] + meUserSyncId is the single source of
// truth for "who is who". Other sources (vikunja users, lastGLANCE intent
// envelopes) map their native owner fields onto the same normalized shape so
// every tool can be scoped by owner_id.

/**
 * @typedef {Object} Person
 * @property {string} id        Normalized owner id.
 * @property {string} name
 * @property {string|null} source Where this person was first seen ('dayglance','vikunja', null).
 */

export class Roster {
  #people = new Map();

  /**
   * Upsert a person by id + name. Names are preferred, never overridden once set.
   * @param {string} id
   * @param {string} name
   * @param {string|null} [source]
   */
  set(id, name, source = null) {
    if (!id) return this;
    if (this.#people.has(id)) {
      const p = this.#people.get(id);
      if (!p.name && name) p.name = String(name);
      return this;
    }
    this.#people.set(id, { id, name: String(name), source });
    return this;
  }

  /**
   * Add a batch from a native users[] roster (dayGLANCE shape) and register
   * each as its own person, plus the viewer's `meUserSyncId`.
   * @param {{users: Array<object>, meUserSyncId?: string|null}} native
   */
  addDayglance({ users = [], meUserSyncId = null }) {
    for (const u of users) {
      const id = u.syncId ?? u.id;
      if (!id) continue;
      this.set(id, u.name ?? u.displayName ?? u.email ?? 'Unknown', 'dayglance');
    }
    if (meUserSyncId) this.set(meUserSyncId, 'Me', 'dayglance');
    return this;
  }

  /** Register a vikunja user (id, username/email, full name). */
  addVikunjaUser({ id, username, email, fullName }) {
    this.set(String(id), fullName ?? username ?? email ?? `User ${id}`, 'vikunja');
    return this;
  }

  get(id) {
    return this.#people.get(id) ?? null;
  }

  list() {
    return [...this.#people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names() {
    return this.list().map((p) => p.name);
  }

  size() {
    return this.#people.size;
  }
}

export default { Roster };
