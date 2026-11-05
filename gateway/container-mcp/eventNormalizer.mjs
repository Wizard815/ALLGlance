// Workaround for an upstream filename mismatch in the GLANCE intents protocol.
//
// @glance-apps/intents 1.4.0 only accepts event files named
//   YYYYMMDDTHHMMSSZ-<6-8 hex>.json
// (FILENAME_RE in its filename helpers), and every receiver lists the events
// folder and skips anything else. But dayGLANCE 5.11 builds a task-completion
// notify with `event_id: task.transitionId ?? eventId()` (src/intents/
// useNotifyEmitter.js), and `transitionId` is a UUID for completions made in the
// UI, so the file lands as `<uuid>.json` and lastGLANCE never ingests it: a chore
// completed from dayGLANCE stays "overdue" in lastGLANCE. (Upstream main is the
// same at the time of writing.)
//
// The fix has to happen on the server both apps share. This renames such files,
// in place, to the form the library accepts, derived from the envelope's own
// emitted_at. The envelope content (including its event_id, encrypted or not) is
// untouched, so receivers de-duplicate by event_id exactly as before; verified
// with the real apps that lastGLANCE then fetches, decrypts and logs the chore.
//
// Conservative by design: only `.json` files in directories whose path mentions
// "event", only files that parse as an intents envelope (event_id + emitted_at),
// never a sync snapshot, never a file written in the last few seconds.

import { readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const FILENAME_RE = /^\d{8}T\d{6}Z-[a-f0-9]{6,8}\.json$/;
const SKIP = /(-sync\.json|-people\.json|intents-encryption-salt\.json|glance-events\.json)$/;

const compact = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function conformingName(envelope) {
  const hex = createHash('sha256').update(String(envelope.event_id)).digest('hex').slice(0, 6);
  return `${compact(envelope.emitted_at)}-${hex}.json`;
}

async function* eventDirs(root, depth = 0, maxDepth = 4) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  if (/event/i.test(root)) yield { dir: root, entries };
  if (depth >= maxDepth) return;
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) yield* eventDirs(join(root, e.name), depth + 1, maxDepth);
}

/** One pass. Returns the list of renames performed: [{ from, to }]. */
export async function normalizeOnce(root, { now = Date.now(), minAgeMs = 3000, log = () => {} } = {}) {
  const done = [];
  for await (const { dir, entries } of eventDirs(root)) {
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const name of names) {
      if (!name.endsWith('.json') || FILENAME_RE.test(name) || SKIP.test(name)) continue;
      const path = join(dir, name);
      try {
        if (now - (await stat(path)).mtimeMs < minAgeMs) continue; // maybe still being written
        const env = JSON.parse(await readFile(path, 'utf8'));
        if (!env || typeof env.event_id !== 'string' || typeof env.emitted_at !== 'string' || Number.isNaN(Date.parse(env.emitted_at))) continue;
        const to = conformingName(env);
        if (names.has(to)) continue; // already normalized copy exists; leave both alone
        await rename(path, join(dir, to));
        log(`[events] renamed ${name} -> ${to}`);
        done.push({ from: name, to });
      } catch {
        // unreadable / not an envelope / raced with a writer: leave it for the next pass
      }
    }
  }
  return done;
}

/** Run forever on an interval; returns a stop function. */
export function startEventNormalizer(root, { intervalMs = 10_000, log = console.log } = {}) {
  let stopped = false;
  const tick = () => normalizeOnce(root, { log }).catch(() => {}).finally(() => { if (!stopped) timer = setTimeout(tick, intervalMs); });
  let timer = setTimeout(tick, 1000);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
