// State store backed by dayGLANCE's own WebDAV sync snapshot.
//
// dayGLANCE (any build: web, desktop, mobile) can sync its whole planner to a
// WebDAV server as one JSON file, `dayglance-sync.json`:
//
//   { schemaVersion, appId: 'dayglance', version, lastModified, data: { tasks,
//     unscheduledTasks, recurringTasks, recycleBin, users, goals, projects, … } }
//
// The AllGLANCE stack runs a WebDAV server (docker-compose service
// `dayglance-sync`) whose data directory is also mounted into this container.
// This store reads that file as the MCP's state — so the gateway always sees
// what the app last synced, with no manual export — and writes MCP mutations
// back into the same file, so the app picks them up on its next sync (it polls
// and merges task-by-task on `lastModified`, the same as for any other device).
//
// It implements the same interface as state.mjs (get / beginWrite / commit /
// replace) so the MCP server is unchanged.
//
// WRITE SAFETY. The app may sync at any moment. A write therefore never
// replaces the file from our in-memory copy: at commit it re-reads the latest
// file and applies only what this write changed (per task id, within the four
// task slices the MCP can mutate), leaving every other field and task exactly
// as the app wrote it. Commits are serialized. The file is replaced atomically
// (temp + rename), which also changes its mtime/ETag, so the WebDAV server
// reports a new version and the app merges it instead of overwriting.
//
// LIMIT. This only works while E2E encryption is OFF in the app's Cloud Sync
// settings (the snapshot must be readable JSON). An encrypted snapshot is
// detected and reported; it is never overwritten.

import { readFile, writeFile, rename, stat, mkdir, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const SLICES = ['tasks', 'unscheduledTasks', 'recurringTasks', 'recycleBin'];

const EMPTY_DATA = () => ({
  tasks: [],
  unscheduledTasks: [],
  recurringTasks: [],
  recycleBin: [],
  users: [],
  goals: [],
  projects: [],
});

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Parse a snapshot document; throws a descriptive error if it is not a readable dayGLANCE snapshot. */
export function parseSnapshot(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('dayglance-sync.json is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || !doc.data || typeof doc.data !== 'object') {
    throw new Error(
      'dayglance-sync.json has no readable "data" (is end-to-end encryption enabled in dayGLANCE → Settings → Sync? ' +
        'The MCP can only read the unencrypted snapshot.)',
    );
  }
  return doc;
}

/**
 * Apply the id-keyed difference base→draft onto `latest` (a list), returning the new list.
 *
 * `stampAt` (ISO) is the container's stand-in for the app's save pass, which
 * diff-stamps `lastModified` on every changed task. Some MCP mutations (e.g.
 * set_task_completion) leave the stamp alone because the app's renderer would
 * stamp it afterwards; with no renderer here, an unstamped change has an EQUAL
 * timestamp to the app's copy, the app's merge keeps its own copy, and the
 * write is silently lost. So a changed task whose stamp did not advance is
 * stamped `stampAt`.
 */
export function applyListDiff(base, draft, latest, stampAt = null) {
  const idOf = (t) => (t && t.id !== undefined && t.id !== null ? String(t.id) : null);
  const baseById = new Map((base || []).map((t) => [idOf(t), t]));
  const draftById = new Map((draft || []).map((t) => [idOf(t), t]));
  let out = Array.isArray(latest) ? [...latest] : [];

  // Removed by this write.
  for (const [id] of baseById) {
    if (id !== null && !draftById.has(id)) out = out.filter((t) => idOf(t) !== id);
  }
  // Added or changed by this write.
  for (const [id, t] of draftById) {
    if (id === null) continue;
    const before = baseById.get(id);
    if (before && isDeepStrictEqual(before, t)) continue;
    let next = t;
    if (stampAt && before && next && typeof next === 'object' && next.lastModified === before.lastModified) {
      next = { ...next, lastModified: stampAt };
    }
    const at = out.findIndex((x) => idOf(x) === id);
    if (at >= 0) out[at] = next;
    else out.push(next);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.file  Path to dayglance-sync.json on the shared volume.
 * @param {() => string} [opts.now]  ISO clock (injectable for tests).
 */
export function createSyncFileStore({ file, now = () => new Date().toISOString() } = {}) {
  if (!file) throw new Error('createSyncFileStore: file is required');

  let cache = null; // { key, doc }
  let base = null; // snapshot of the four slices at beginWrite
  let draft = null;
  let chain = Promise.resolve(); // serializes commits

  async function readDoc() {
    let st;
    try {
      st = await stat(file);
    } catch {
      return { doc: null, key: 'absent' };
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.key === key) return cache;
    const doc = parseSnapshot(await readFile(file, 'utf8'));
    cache = { key, doc };
    return cache;
  }

  function stateOf(doc) {
    const data = doc ? doc.data : {};
    return { ...EMPTY_DATA(), ...clone(data), weekStartDay: data.weekStartDay ?? 0 };
  }

  async function writeDoc(doc) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(doc), 'utf8');
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    cache = null;
  }

  return {
    async get() {
      const { doc } = await readDoc();
      return { state: stateOf(doc) };
    },

    async beginWrite() {
      const { doc } = await readDoc();
      const state = stateOf(doc);
      base = Object.fromEntries(SLICES.map((k) => [k, clone(state[k])]));
      draft = state;
      const setters = {
        setTasks: (v) => { draft.tasks = v; },
        setUnscheduledTasks: (v) => { draft.unscheduledTasks = v; },
        setRecurringTasks: (v) => { draft.recurringTasks = v; },
        setRecycleBin: (v) => { draft.recycleBin = v; },
      };
      return { state: draft, setters };
    },

    async commit() {
      const mine = { base, draft };
      base = null;
      draft = null;
      if (!mine.draft) return;
      const run = async () => {
        cache = null; // always diff against the file as it is NOW
        const { doc: latestDoc } = await readDoc();
        const doc = latestDoc
          ? clone(latestDoc)
          : { schemaVersion: 1, appId: 'dayglance', version: 2, lastModified: now(), data: EMPTY_DATA() };
        let changed = false;
        for (const k of SLICES) {
          const next = applyListDiff(mine.base[k], mine.draft[k], doc.data[k], now());
          if (!isDeepStrictEqual(next, doc.data[k] ?? [])) {
            doc.data[k] = next;
            changed = true;
          }
        }
        if (!changed) return;
        doc.lastModified = now();
        await writeDoc(doc);
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      await p;
    },

    /** Not supported: the snapshot is owned by the app; replacing it wholesale would clobber it. */
    async replace() {
      throw new Error('replace() is not supported for the sync-file store');
    },
  };
}

export default createSyncFileStore;
