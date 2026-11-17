// Who is calling, and what they may see.
//
//   admin      GATEWAY_TOKEN: everything, as before. With no GATEWAY_TOKEN set, a caller
//              without a token is admin too (the open gateway the start-up log warns about).
//   household  a blanket family token: shared items and every member's non-private items.
//   person     one roster member's token: what household sees, plus their own private items.
//
// Scoped tokens are made with scripts/tokens.mjs, printed once, and kept here only as
// sha-256 hashes in a JSON file on the data volume (ALLGLANCE_TOKENS_FILE).
//
// What counts as private (see README "Per-person scoping"):
//   Vikunja     a label titled PRIVATE_LABEL ("private"), or a project listed in
//               VIKUNJA_PRIVATE_PROJECTS. It belongs to its assignees (and the project's owner).
//   dayGLANCE   a #private tag in the title. It belongs to its assignees.
//   lastGLANCE / lifeGLANCE   no marker exists: everything is household-visible.
//   Omi         all of it is one person's (OMI_OWNER_ID); without that, admin-only.
//   vikunja_native_*  cannot be scoped: admin-only.
// A private item with no known owner is hidden from every scoped token.
//
// The gateway applies these rules in one place (Gateway.as(scope)); every REST route and
// MCP tool goes through it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const TOKEN_PREFIX = 'alg_';
export const KINDS = ['household', 'person'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export const ADMIN = Object.freeze({ kind: 'admin', name: null, owner_id: null, ids: Object.freeze([]) });

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------------ token file */

/** The scoped tokens in `file` (records, hashes included). A missing file is no tokens. */
export function readTokens(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`cannot read the token file ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`the token file ${file} is not valid JSON; fix or remove it`);
  }
  return Array.isArray(data?.tokens) ? data.tokens : [];
}

function writeTokens(file, tokens) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not ours to change */ }
}

/**
 * Make a scoped token, store its hash, and return the token (the only time it exists in clear).
 * @param {string} file
 * @param {{ kind: 'household'|'person', name: string, owner_id?: string, also?: string[] }} spec
 */
export function issueToken(file, { kind, name, owner_id = null, also = [] }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be household or person, got "${kind}"`);
  if (!NAME_RE.test(String(name ?? ''))) throw new Error(`give the token a short name (letters, digits, . _ -), e.g. kitchen-tablet; got "${name ?? ''}"`);
  if (kind === 'person' && !String(owner_id ?? '').trim()) throw new Error('a person token needs the owner_id it belongs to (see GET /api/allglance/users)');
  const tokens = readTokens(file);
  if (tokens.some((t) => t.name === name)) throw new Error(`a token named "${name}" already exists; pick another name or revoke it first`);
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const record = {
    name,
    kind,
    owner_id: kind === 'person' ? String(owner_id).trim() : null,
    ...(kind === 'person' && also.length ? { also: [...new Set(also.map((x) => String(x).trim()).filter(Boolean))] } : {}),
    hash: sha256(token),
    created: new Date().toISOString().slice(0, 10),
  };
  writeTokens(file, [...tokens, record]);
  return { token, record };
}

/** Remove the token called `name`. Returns how many were removed (0 or 1). */
export function revokeToken(file, name) {
  const before = readTokens(file);
  const after = before.filter((t) => t.name !== name);
  if (after.length !== before.length) writeTokens(file, after);
  return before.length - after.length;
}

/** Records without their hashes: safe to show. */
export const describeTokens = (tokens) => tokens.map(({ hash: _h, ...rest }) => ({ also: [], ...rest }));

/** The caller scope a stored record grants. */
export function scopeOf(record) {
  if (record.kind === 'person') {
    const ids = [String(record.owner_id), ...(record.also ?? []).map(String)];
    return Object.freeze({ kind: 'person', name: record.name, owner_id: String(record.owner_id), ids: Object.freeze([...new Set(ids)]) });
  }
  return Object.freeze({ kind: 'household', name: record.name, owner_id: null, ids: Object.freeze([]) });
}

/**
 * Reads the token file on demand and re-reads it when it changes, so `tokens.mjs add` and
 * `revoke` take effect without a restart. An unreadable file means no scoped token works.
 */
export class TokenStore {
  #file;
  #seen = null; // mtime + size of the file last read
  #byHash = new Map();
  #warned = false;

  constructor(file) {
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  #load() {
    let st = null;
    try { st = statSync(this.#file); } catch { /* no file: no tokens */ }
    const key = st ? `${st.mtimeMs}:${st.size}` : 'none';
    if (key === this.#seen) return;
    this.#seen = key;
    this.#byHash = new Map();
    if (!st) return;
    try {
      for (const t of readTokens(this.#file)) {
        if (typeof t?.hash === 'string' && KINDS.includes(t.kind) && (t.kind !== 'person' || t.owner_id)) this.#byHash.set(t.hash, t);
      }
      this.#warned = false;
    } catch (err) {
      if (!this.#warned) console.warn(`[gateway] scoped tokens disabled: ${err.message}`);
      this.#warned = true;
    }
  }

  /** The stored record for a presented token, or null. */
  lookup(token) {
    if (!String(token ?? '').startsWith(TOKEN_PREFIX)) return null;
    this.#load();
    return this.#byHash.get(sha256(token)) ?? null;
  }

  size() {
    this.#load();
    return this.#byHash.size;
  }
}

/* ------------------------------------------------------------------ requests */

const bearer = (req) => String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '').trim();

function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Express middleware for /api/allglance and /mcp: sets req.scope, or answers 401.
 * @param {{ adminToken: string, store?: TokenStore }} opts
 */
export function authenticate({ adminToken, store }) {
  return (req, res, next) => {
    const got = bearer(req);
    if (adminToken && got && sameSecret(got, adminToken)) {
      req.scope = ADMIN;
      return next();
    }
    if (got.startsWith(TOKEN_PREFIX)) {
      const record = store?.lookup(got);
      if (record) {
        req.scope = scopeOf(record);
        return next();
      }
      return res.status(401).json({ error: 'This alg_ token is not known here: it was revoked, mistyped, or made for another gateway.' });
    }
    if (!adminToken) {
      req.scope = ADMIN; // open gateway, as before GATEWAY_TOKEN was set
      return next();
    }
    res.status(401).json({ error: 'Send Authorization: Bearer <token>: GATEWAY_TOKEN, or a household or person alg_ token.' });
  };
}

/* ------------------------------------------------------------------ privacy */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse VIKUNJA_PRIVATE_PROJECTS ("12:3,14:5") into project id -> owner id. Throws on a typo. */
export function parsePrivateProjects(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*:\s*(\S+)$/.exec(part);
    if (!m) throw new Error(`VIKUNJA_PRIVATE_PROJECTS: "${part}" should be <project id>:<owner id>, e.g. 12:3`);
    out.set(m[1], m[2]);
  }
  return out;
}

/** The privacy rules for one gateway, from config.access. */
export function policyFrom(access = {}) {
  const label = String(access.privateLabel ?? 'private').trim().toLowerCase() || 'private';
  return {
    label,
    tag: new RegExp(`#${escapeRe(label)}(?![\\p{L}\\p{N}_/-])`, 'iu'),
    projects: parsePrivateProjects(access.privateProjects),
    omiOwner: String(access.omiOwner ?? '').trim(),
  };
}

/** Every id an item belongs to: all assignees the source records, not only the first. */
export function ownersOf(item) {
  const ids = new Set();
  for (const x of [item ?? {}, item?.extra ?? {}]) {
    if (x.owner_id != null && x.owner_id !== '') ids.add(String(x.owner_id));
    if (x.assignee_id != null && x.assignee_id !== '') ids.add(String(x.assignee_id));
    for (const a of Array.isArray(x.assignees) ? x.assignees : []) if (a?.id != null) ids.add(String(a.id));
    for (const id of Array.isArray(x.assignedUserSyncIds) ? x.assignedUserSyncIds : []) if (id) ids.add(String(id));
    for (const id of Array.isArray(x.assigned_user_sync_ids) ? x.assigned_user_sync_ids : []) if (id) ids.add(String(id));
  }
  return ids;
}

/**
 * Who a private item belongs to, or null when it is not private.
 * @param {object} item  a canonical task, a dayGLANCE block, a chore or a milestone
 * @param {string} source  'vikunja' | 'dayglance' | 'lastglance' | 'lifeglance'
 * @param {ReturnType<typeof policyFrom>} policy
 * @returns {Set<string>|null}
 */
export function privateOwners(item, source, policy) {
  if (source === 'vikunja') {
    const x = item?.extra ?? item ?? {};
    const labelled = (Array.isArray(x.labels) ? x.labels : []).some((l) => String(l?.title ?? '').trim().toLowerCase() === policy.label);
    const projectOwner = policy.projects.get(String(item?.project_id ?? x.project_id ?? ''));
    if (!labelled && !projectOwner) return null;
    const owners = ownersOf(item);
    if (projectOwner) owners.add(projectOwner);
    return owners;
  }
  if (source === 'dayglance') {
    return policy.tag.test(String(item?.title ?? '')) ? ownersOf(item) : null;
  }
  return null; // lastGLANCE and lifeGLANCE carry no privacy marker
}

/** Whether `scope` may see `item`. */
export function canSee(scope, item, source, policy) {
  if (scope.kind === 'admin') return true;
  const owners = privateOwners(item, source, policy);
  if (!owners) return true;
  return scope.kind === 'person' && scope.ids.some((id) => owners.has(id));
}

/** Omi is one person's wearable: admin, or a person token of OMI_OWNER_ID. */
export function omiAllowed(scope, policy) {
  if (scope.kind === 'admin') return true;
  return scope.kind === 'person' && Boolean(policy.omiOwner) && scope.ids.includes(policy.omiOwner);
}

/** Why `scope` may not call tool `name`, or null when it may. */
export function toolRefusal(scope, name, policy) {
  if (scope.kind === 'admin') return null;
  if (name.startsWith('vikunja_native_')) {
    return `${name} is Vikunja's own tool and cannot hide private tasks, so only the admin token (GATEWAY_TOKEN) may use it. Use the allglance_* tools.`;
  }
  if (name.startsWith('omi_') && !omiAllowed(scope, policy)) {
    return `${name} reads one person's Omi wearable. Only the admin token${policy.omiOwner ? ` and ${policy.omiOwner}'s person token` : ''} may use it${policy.omiOwner ? '' : ' (OMI_OWNER_ID is not set)'}.`;
  }
  return null;
}

/** What GET /api/allglance/whoami and allglance_whoami answer. */
export function whoami(scope, policy, { omiEnabled = false } = {}) {
  return {
    scope: scope.kind,
    owner_id: scope.owner_id ?? null,
    ...(scope.kind === 'person' ? { also: scope.ids.filter((id) => id !== scope.owner_id) } : {}),
    name: scope.name ?? null,
    sees_private: scope.kind === 'admin' ? 'all' : scope.kind === 'person' ? 'own' : 'none',
    omi: omiEnabled && omiAllowed(scope, policy),
  };
}
