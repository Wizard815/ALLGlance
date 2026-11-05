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
// ENCRYPTION. If the app has end-to-end encryption on, the snapshot is an
// envelope { v: 1, enc: 'AES-GCM-256', data: base64(salt16 | iv12 | ciphertext) }
// whose key is PBKDF2-SHA256 (310 000 iterations) of the user's sync passphrase
// and the embedded salt (@glance-apps/sync crypto.js). Give the MCP the same
// passphrase (DAYGLANCE_SYNC_PASSPHRASE) and it decrypts to read, and on write
// re-encrypts with the file's EXISTING salt and a fresh IV — keeping the salt is
// essential: the apps cache a key derived for that salt and could not read a
// file re-salted by us without asking for the passphrase again. Without the
// passphrase an encrypted file is reported, never overwritten.

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

const PBKDF2_ITERATIONS = 310_000;

export const isEncryptedEnvelope = (v) =>
  v !== null && typeof v === 'object' && v.v === 1 && v.enc === 'AES-GCM-256' && typeof v.data === 'string';

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Decrypt an app envelope with the shared passphrase → { doc, salt }. */
export async function decryptEnvelope(envelope, passphrase) {
  const packed = Buffer.from(envelope.data, 'base64');
  const salt = new Uint8Array(packed.subarray(0, 16));
  const iv = new Uint8Array(packed.subarray(16, 28));
  const ciphertext = new Uint8Array(packed.subarray(28));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(passphrase, salt), ciphertext);
  } catch {
    throw new Error('Cannot decrypt dayglance-sync.json: wrong DAYGLANCE_SYNC_PASSPHRASE (or the file is corrupted).');
  }
  return { doc: JSON.parse(new TextDecoder().decode(plain)), salt };
}

/** Encrypt a snapshot document into an envelope, reusing `salt` and a fresh IV. */
export async function encryptDoc(doc, passphrase, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(passphrase, salt), new TextEncoder().encode(JSON.stringify(doc))));
  const packed = new Uint8Array(salt.length + iv.length + ct.length);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(ct, salt.length + iv.length);
  return { v: 1, enc: 'AES-GCM-256', data: Buffer.from(packed).toString('base64') };
}

/**
 * Parse a snapshot file's text → { doc, salt }. `salt` is set when the file is
 * encrypted (so writes can re-encrypt with it). Throws a descriptive error if it
 * is not a readable dayGLANCE snapshot.
 */
export async function parseSnapshot(raw, passphrase = null) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('dayglance-sync.json is not valid JSON');
  }
  let salt = null;
  if (isEncryptedEnvelope(doc)) {
    if (!passphrase) {
      throw new Error(
        'dayglance-sync.json is end-to-end encrypted: set DAYGLANCE_SYNC_PASSPHRASE to the same sync passphrase ' +
          'you entered in dayGLANCE (Settings → Sync → End-to-end encryption).',
      );
    }
    ({ doc, salt } = await decryptEnvelope(doc, passphrase));
  }
  if (!doc || typeof doc !== 'object' || !doc.data || typeof doc.data !== 'object') {
    throw new Error('dayglance-sync.json has no readable "data" (unexpected format).');
  }
  return { doc, salt };
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
 * @param {string} [opts.passphrase]  Shared sync passphrase (needed iff the app has E2E encryption on).
 * @param {() => string} [opts.now]  ISO clock (injectable for tests).
 */
export function createSyncFileStore({ file, passphrase = null, now = () => new Date().toISOString() } = {}) {
  if (!file) throw new Error('createSyncFileStore: file is required');

  let cache = null; // { key, doc, salt }
  let base = null; // snapshot of the four slices at beginWrite
  let draft = null;
  let chain = Promise.resolve(); // serializes commits

  async function readDoc() {
    let st;
    try {
      st = await stat(file);
    } catch {
      return { doc: null, salt: null, key: 'absent' };
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.key === key) return cache;
    const { doc, salt } = await parseSnapshot(await readFile(file, 'utf8'), passphrase);
    cache = { key, doc, salt };
    return cache;
  }

  function stateOf(doc) {
    const data = doc ? doc.data : {};
    return { ...EMPTY_DATA(), ...clone(data), weekStartDay: data.weekStartDay ?? 0 };
  }

  async function writeDoc(doc, salt) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
    const body = salt ? await encryptDoc(doc, passphrase, salt) : doc;
    await writeFile(tmp, JSON.stringify(body), 'utf8');
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
        const { doc: latestDoc, salt } = await readDoc();
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
        await writeDoc(doc, salt);
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
