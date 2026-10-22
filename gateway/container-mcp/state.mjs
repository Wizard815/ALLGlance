// State store for the containerized dayGLANCE MCP.
//
// The Electron app keeps task state in the renderer's React state (backed by
// the visiting browser's localStorage). A container has no renderer, so this
// store is the substitute source of truth: a single JSON state document on
// disk (a mounted volume), shaped exactly like the React slices the vendored
// model reads (tasks / unscheduledTasks / recurringTasks / users / goals /
// projects / weekStartDay).
//
// It is DELIBERATELY simple and honest: it does not invent data. If the file
// is absent it starts EMPTY, so a read returns an empty day rather than a
// fabricated one. Hydrating it from GLANCEvault (decrypting the apps' rows) is
// a separate provider the server can be handed via opts.vault — see vault.mjs.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = () => ({
  tasks: [],
  unscheduledTasks: [],
  recurringTasks: [],
  recycleBin: [],
  users: [],
  goals: [],
  projects: [],
  weekStartDay: 0,
});

function clone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/**
 * @param {object} opts
 * @param {string} opts.file  Path to the JSON state document (default /data/dayglance-state.json).
 * @param {object} [opts.vault] Optional vault provider: { load(): Promise<partial-state|null> }.
 *                              Used to hydrate when the local file is empty.
 */
export function createStateStore({ file, vault = null } = {}) {
  let state = EMPTY();
  let loaded = false;
  let draft = null;

  async function loadFromDisk() {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...EMPTY(), ...parsed };
    } catch {
      return null;
    }
  }

  async function hydrate() {
    const disk = await loadFromDisk();
    if (disk) { state = disk; return; }
    if (vault && typeof vault.load === 'function') {
      try {
        const fromVault = await vault.load();
        if (fromVault && typeof fromVault === 'object') state = { ...EMPTY(), ...fromVault };
      } catch {
        // Vault unavailable this boot; stay empty rather than fail the read.
      }
    }
  }

  async function persist() {
    const tmp = `${file}.tmp`;
    // Atomic-ish write: write temp then rename, so a crash mid-write cannot
    // leave a truncated state document.
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, file);
  }

  return {
    async get() {
      if (!loaded) { await hydrate(); loaded = true; }
      return { state };
    },

    async beginWrite() {
      if (!loaded) { await hydrate(); loaded = true; }
      draft = clone(state);
      const setters = {
        setTasks: (v) => { draft.tasks = v; },
        setUnscheduledTasks: (v) => { draft.unscheduledTasks = v; },
        setRecurringTasks: (v) => { draft.recurringTasks = v; },
        setRecycleBin: (v) => { draft.recycleBin = v; },
      };
      return { state: draft, setters };
    },

    async commit() {
      if (draft) { state = draft; draft = null; }
      try { await persist(); } catch { /* read-only volume: keep in-memory state */ }
    },

    /** Replace the whole state (used by vault hydration / external loaders). */
    async replace(next) {
      state = { ...EMPTY(), ...next };
      loaded = true;
      try { await persist(); } catch { /* ignore */ }
    },
  };
}

export default createStateStore;
