// Reads the sync snapshot a GLANCE app writes to the shared WebDAV directory.
//
// Every GLANCE app (dayGLANCE, lastGLANCE, lifeGLANCE) syncs through the same
// engine (@glance-apps/sync) and writes one JSON file, `<app>-sync.json`:
//   { schemaVersion, appId, version, lastModified, data: { … } }
// With end-to-end encryption on, the file is instead an envelope
//   { v: 1, enc: 'AES-GCM-256', data: base64(salt16 | iv12 | ciphertext) }
// keyed by PBKDF2-SHA256 (310 000 iterations) over the household sync passphrase
// and the embedded salt. Because all apps share one passphrase, ONE passphrase
// (GLANCE_SYNC_PASSPHRASE) lets the gateway read all of them.
//
// This is how lastGLANCE / lifeGLANCE data reaches the gateway: those apps keep
// their data in IndexedDB, which nothing outside the browser can read, but each
// one syncs it to this file as part of normal Cloud Sync — so no manual export.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ITERATIONS = 310_000;

export const isEncryptedEnvelope = (v) =>
  v !== null && typeof v === 'object' && v.v === 1 && v.enc === 'AES-GCM-256' && typeof v.data === 'string';

export async function decryptEnvelope(envelope, passphrase) {
  const packed = Buffer.from(envelope.data, 'base64');
  const salt = new Uint8Array(packed.subarray(0, 16));
  const iv = new Uint8Array(packed.subarray(16, 28));
  const ct = new Uint8Array(packed.subarray(28));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  try {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)));
  } catch {
    throw new Error('cannot decrypt the sync snapshot: wrong GLANCE_SYNC_PASSPHRASE (or corrupted file)');
  }
}

/** Find `filename` under `root` (the app's folder is whatever the user typed in its Sync folder field). */
export async function findSnapshot(root, filename, maxDepth = 4) {
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.isFile() && e.name === filename);
    if (hit) return join(dir, hit.name);
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const found = await walk(join(dir, e.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root, 0);
}

/**
 * Read + (if needed) decrypt an app's snapshot.
 * @returns {Promise<{ doc: object, path: string } | null>} null when the app has not synced yet.
 */
export async function readSnapshot({ dir, filename, passphrase = '', file = '' }) {
  // `file` pins an exact path (the folder the app was told to sync to), which
  // matters when more than one folder under `dir` holds a snapshot of that name.
  const path = file || (await findSnapshot(dir, filename));
  if (!path) return null;
  if (file) { try { await stat(file); } catch { return null; } }
  const raw = JSON.parse(await readFile(path, 'utf8'));
  let doc = raw;
  if (isEncryptedEnvelope(raw)) {
    if (!passphrase) {
      throw new Error(
        `${filename} is end-to-end encrypted: set GLANCE_SYNC_PASSPHRASE to the sync passphrase used in the GLANCE apps`,
      );
    }
    doc = await decryptEnvelope(raw, passphrase);
  }
  if (!doc || typeof doc.data !== 'object' || doc.data === null) {
    throw new Error(`${filename} has an unexpected format`);
  }
  return { doc, path, modifiedAt: (await stat(path)).mtime.toISOString() };
}

export default { readSnapshot, findSnapshot, decryptEnvelope, isEncryptedEnvelope };
