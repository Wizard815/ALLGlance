// Conditional-write guard in front of the WebDAV sync server.
//
// The GLANCE apps upload their snapshot with `If-Match: <etag it just read>` so that a
// device which was not up to date cannot overwrite a newer file (and `If-None-Match: *`
// for the very first write). hacdias/webdav ignores both on PUT: a stale write is simply
// accepted, and the other device's changes are lost. This small reverse proxy sits on the
// public sync port and enforces them (RFC 9110 section 13.1), then forwards everything
// else untouched.
//
//   apps ──▶ guard :6065 ──▶ webdav 127.0.0.1:6066 ──▶ /sync
//
// Rules, for PUT / DELETE / MOVE (the methods that replace or remove a file):
//   If-Match: "<etag>"[, ...] | *   -> the file must exist and carry one of the ETags
//   If-None-Match: *                -> the file must not exist
// otherwise 412 Precondition Failed and nothing is written. The check and the write are
// one critical section per path, so two devices racing on the same file cannot both pass.
// Reads (GET/HEAD/PROPFIND/OPTIONS) and unconditional writes pass straight through and
// stream; only a conditional write waits for its turn.
//
// What this cannot see: a writer that does not come through the guard (the gateway/MCP
// replacing dayglance-sync.json on disk). That write changes the file's ETag, so the next
// stale device upload is refused, which is the point; the window between the guard's check
// and an outside write landing is a few milliseconds.

import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const GUARDED = new Set(['PUT', 'DELETE', 'MOVE']);

const strip = (tag) => String(tag).trim().replace(/^W\//, '');

/** Does the request carry a precondition this guard must evaluate? */
export function hasPrecondition(req) {
  return GUARDED.has(req.method) && (req.headers['if-match'] !== undefined || req.headers['if-none-match'] !== undefined);
}

/** Evaluate If-Match / If-None-Match against the current ETag (null = no such file). */
export function preconditionHolds(headers, currentEtag) {
  const ifMatch = headers['if-match'];
  if (ifMatch !== undefined) {
    if (currentEtag === null) return false;
    const wanted = String(ifMatch).trim();
    if (wanted !== '*' && !wanted.split(',').some((t) => strip(t) === strip(currentEtag))) return false;
  }
  const none = headers['if-none-match'];
  if (none !== undefined) {
    const wanted = String(none).trim();
    if (wanted === '*') {
      if (currentEtag !== null) return false;
    } else if (currentEtag !== null && wanted.split(',').some((t) => strip(t) === strip(currentEtag))) {
      return false;
    }
  }
  return true;
}

/**
 * @param {{ backendHost?: string, backendPort: number, log?: (m: string) => void }} opts
 * @returns {http.Server}
 */
export function createSyncGuard({ backendHost = '127.0.0.1', backendPort, log = () => {} } = {}) {
  if (!backendPort) throw new Error('createSyncGuard: backendPort is required');
  const queues = new Map(); // path -> tail of that path's write queue

  const forwardHeaders = (headers) => {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
    return out;
  };

  /** Current ETag of a path as the backend reports it: string, null (404), or undefined (unknown: auth refused, backend error). */
  const currentEtag = (path, authorization) => new Promise((resolve) => {
    const headers = authorization ? { authorization } : {};
    const r = http.request({ host: backendHost, port: backendPort, path, method: 'HEAD', headers, timeout: 5000 }, (res) => {
      res.resume();
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.headers.etag ?? undefined);
      resolve(undefined);
    });
    r.on('error', () => resolve(undefined));
    r.on('timeout', () => { r.destroy(); resolve(undefined); });
    r.end();
  });

  function proxy(req, res) {
    return new Promise((resolve) => {
      const up = http.request(
        { host: backendHost, port: backendPort, path: req.url, method: req.method, headers: forwardHeaders(req.headers) },
        (upRes) => {
          const headers = {};
          for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) headers[k] = v;
          res.writeHead(upRes.statusCode, upRes.statusMessage, headers);
          upRes.pipe(res);
          upRes.on('end', resolve);
          upRes.on('error', resolve);
        },
      );
      up.on('error', (err) => {
        log(`[sync-guard] backend error: ${err.message}`);
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('WebDAV server unavailable'); }
        else res.destroy();
        resolve();
      });
      res.on('close', resolve);
      req.pipe(up);
    });
  }

  const server = http.createServer(async (req, res) => {
    if (!hasPrecondition(req)) return void (await proxy(req, res));

    const key = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const prev = queues.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    try {
      await prev;
      const etag = await currentEtag(req.url, req.headers.authorization);
      if (etag !== undefined && !preconditionHolds(req.headers, etag)) {
        log(`[sync-guard] 412 ${req.method} ${key} (If-Match ${req.headers['if-match'] ?? '-'} vs ${etag ?? 'absent'})`);
        req.resume();
        res.writeHead(412, { 'content-type': 'text/plain', ...(etag ? { etag } : {}) });
        res.end('Precondition Failed');
        return;
      }
      // etag undefined (auth refused / backend trouble): let the backend answer for itself.
      await proxy(req, res);
    } finally {
      release();
    }
  });
  return server;
}

// ---- entrypoint (run by supervisor.mjs) ----------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SYNC_GUARD_PORT ?? 6065);
  const backendPort = Number(process.env.SYNC_BACKEND_PORT ?? 6066);
  const server = createSyncGuard({ backendPort, log: (m) => console.log(m) });
  server.listen(port, process.env.SYNC_GUARD_HOST ?? '0.0.0.0', () => console.log(`[sync-guard] :${port} -> 127.0.0.1:${backendPort}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
