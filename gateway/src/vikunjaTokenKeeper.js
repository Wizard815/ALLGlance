// Keeps the gateway's Vikunja API token alive, so nobody has to remember an expiry date.
//
// An API token cannot renew itself, so the keeper needs a Vikunja login (VIKUNJA_USERNAME /
// VIKUNJA_PASSWORD, saved on the admin page). Every few hours it signs in, looks at the token it
// is using (Vikunja lists a user's tokens with their expiry and permissions, never the secret), and
// when that token is near its end, or Vikunja refuses it, it:
//   1. makes a new token with the same permissions and a fresh lifetime,
//   2. checks the new one works,
//   3. saves it (admin settings file, mode 600) and switches the running gateway over to it,
//   4. deletes the old token in Vikunja.
// Without a login it only checks the token still works and says so on the admin page.
//
// What it remembers about the token (Vikunja id, expiry) is kept in a small state file next to
// the admin settings; the token itself only ever lives in the admin settings file.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { saveOverrides } from './adminSettings.js';

const DAY = 86_400_000;
export const TITLE = 'allglance-gateway';
// What a gateway token needs when there is no old one to copy (a token that was refused): the
// everyday task work the adapter does, the user search the roster uses, and Vikunja's own MCP.
export const DEFAULT_PERMISSIONS = {
  projects: ['create', 'read_all', 'read_one', 'update'],
  tasks: ['create', 'read_all', 'read_one', 'update'],
  tasks_assignees: ['create', 'read_all'],
};

export class VikunjaTokenKeeper {
  /**
   * @param {{ config: object, settingsFile: string, stateFile?: string, fetchImpl?: typeof fetch,
   *           now?: () => number, renewBeforeDays?: number, lifetimeDays?: number, intervalMs?: number, log?: Console }} opts
   */
  constructor({ config, settingsFile, stateFile, fetchImpl = fetch, now = () => Date.now(), renewBeforeDays = 30, lifetimeDays = 365, intervalMs = 6 * 3600_000, log = console }) {
    this.config = config;
    this.settingsFile = settingsFile;
    this.stateFile = stateFile ?? `${dirname(settingsFile)}/vikunja-token.json`;
    this.fetch = fetchImpl;
    this.now = now;
    this.renewBeforeMs = renewBeforeDays * DAY;
    this.lifetimeMs = lifetimeDays * DAY;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.last = { state: 'unchecked', checkedAt: null };
  }

  get base() { return this.config.vikunja.url.replace(/\/$/, ''); }
  get login() {
    const u = process.env.VIKUNJA_USERNAME ?? '', p = process.env.VIKUNJA_PASSWORD ?? '';
    return u && p ? { username: u, password: p } : null;
  }

  #readState() {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) ?? {}; } catch { return {}; }
  }
  #writeState(s) {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  async #call(method, path, { token, body } = {}) {
    const res = await this.fetch(this.base + '/api/v1' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  }

  /** Does Vikunja accept this API token? true / false, or null when Vikunja could not be asked. */
  async works(token) {
    if (!token) return false;
    try {
      const r = await this.#call('GET', '/projects?per_page=1', { token });
      if (r.status === 200) return true;
      if (r.status === 401 || r.status === 403) return false;
      return null;
    } catch {
      return null;
    }
  }

  /** What the admin page and /health show. Never contains a secret. */
  status() {
    const s = this.#readState();
    const exp = s.expiresAt ? Date.parse(s.expiresAt) : null;
    return {
      ...this.last,
      autoRenew: Boolean(this.login),
      expiresAt: s.expiresAt ?? null,
      daysLeft: exp ? Math.floor((exp - this.now()) / DAY) : null,
      lastRenewedAt: s.renewedAt ?? null,
    };
  }

  /** One check (and renewal when due). Concurrent calls share one run. */
  check({ force = false } = {}) {
    if (!this.running) this.running = this.#check(force).finally(() => { this.running = null; });
    return this.running;
  }

  async #check(force) {
    const at = new Date(this.now()).toISOString();
    const token = this.config.vikunja.token;
    const login = this.login;
    const ok = await this.works(token);
    if (!login) {
      this.last = ok === null
        ? { state: 'unreachable', checkedAt: at, error: 'Vikunja did not answer' }
        : ok ? { state: 'ok', checkedAt: at, note: 'Save a Vikunja login to renew this token automatically.' }
          : { state: 'invalid', checkedAt: at, error: 'Vikunja refuses the token. Save a new token, or a Vikunja login so the gateway can make one.' };
      return this.status();
    }
    if (ok === null) { this.last = { state: 'unreachable', checkedAt: at, error: 'Vikunja did not answer' }; return this.status(); }

    let jwt;
    try {
      const r = await this.#call('POST', '/login', { body: { username: login.username, password: login.password, long_token: false } });
      if (r.status !== 200 || !r.data?.token) throw new Error(r.status === 412 || r.status === 403 || r.status === 401 ? 'the saved Vikunja login was refused' : `login answered ${r.status}`);
      jwt = r.data.token;
    } catch (err) {
      this.last = { state: ok ? 'ok' : 'invalid', checkedAt: at, error: `Cannot renew: ${err.message}.` };
      return this.status();
    }

    const listed = await this.#call('GET', '/tokens', { token: jwt });
    const mine = Array.isArray(listed.data) ? listed.data : [];
    const state = this.#readState();
    // The token in use: the id remembered from the last renewal; before the first renewal, the one
    // gateway token there is (by title). Unsure means unknown expiry, and a working token is kept.
    let current = mine.find((t) => t.id === state.id)
      ?? (() => { const c = mine.filter((t) => String(t.title ?? '').startsWith(TITLE)); return c.length === 1 ? c[0] : null; })();
    if (current && ok) this.#writeState({ ...state, id: current.id, expiresAt: current.expires_at });
    const exp = current?.expires_at ? Date.parse(current.expires_at) : null;
    const due = force || !ok || (exp !== null && exp - this.now() <= this.renewBeforeMs);
    if (!due) {
      this.last = { state: 'ok', checkedAt: at };
      return this.status();
    }

    // Renew: same permissions as the token being replaced, else the gateway's usual set.
    const permissions = current?.permissions && Object.keys(current.permissions).length ? current.permissions : DEFAULT_PERMISSIONS;
    const expiresAt = new Date(this.now() + this.lifetimeMs).toISOString();
    try {
      const made = await this.#call('PUT', '/tokens', { token: jwt, body: { title: TITLE, expires_at: expiresAt, permissions } });
      const fresh = made.data?.token;
      if (made.status >= 300 || !String(fresh ?? '').startsWith('tk_')) throw new Error(`Vikunja answered ${made.status} when asked for a new token`);
      if ((await this.works(fresh)) !== true) {
        await this.#call('DELETE', `/tokens/${made.data.id}`, { token: jwt }).catch(() => {});
        throw new Error('the new token did not work, so the old one is kept');
      }
      saveOverrides(this.settingsFile, { VIKUNJA_TOKEN: fresh });     // survives restarts
      process.env.VIKUNJA_TOKEN = fresh;
      this.config.vikunja.token = fresh;                                // the running adapters read it from here
      this.#writeState({ id: made.data.id, expiresAt: made.data.expires_at ?? expiresAt, renewedAt: at });
      if (current && current.id !== made.data.id) {
        const del = await this.#call('DELETE', `/tokens/${current.id}`, { token: jwt }).catch(() => ({ status: 0 }));
        if (del.status >= 300 || del.status === 0) this.log.warn(`[vikunja-token] renewed, but the old token (#${current.id}) could not be deleted in Vikunja; delete it there by hand`);
      }
      this.log.log(`[vikunja-token] renewed: new token #${made.data.id} valid until ${(made.data.expires_at ?? expiresAt).slice(0, 10)}`);
      this.last = { state: 'ok', checkedAt: at, renewed: true };
    } catch (err) {
      this.log.warn(`[vikunja-token] renewal failed: ${err.message}`);
      this.last = { state: ok ? 'expiring' : 'invalid', checkedAt: at, error: `Renewal failed: ${err.message}.` };
    }
    return this.status();
  }

  start() {
    const run = () => this.check().catch((err) => this.log.warn(`[vikunja-token] check failed: ${err.message}`));
    setTimeout(run, 5000).unref?.();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

export default VikunjaTokenKeeper;
