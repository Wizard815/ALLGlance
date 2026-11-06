// CalDAV front door: the gateway serves Vikunja's CalDAV at /dav so calendar
// apps, phones and Home Assistant can all point at ONE address (the gateway).
//
// It is a transparent reverse proxy, not a reimplementation: Vikunja is the
// CalDAV server. The paths are kept identical (/dav/...), so the absolute hrefs
// Vikunja puts in its responses stay valid and nothing needs rewriting.
//
//  - Methods: every WebDAV/CalDAV verb passes through (PROPFIND, REPORT, PUT,
//    DELETE, MKCOL, PROPPATCH, MOVE, COPY, OPTIONS...). Bodies are streamed.
//  - Auth: CalDAV clients speak HTTP Basic, so the Authorization header goes to
//    Vikunja untouched and Vikunja's own login (or a CalDAV token) decides. The
//    gateway's bearer token (GATEWAY_TOKEN) does NOT apply here.
//  - /.well-known/caldav (and a PROPFIND on the server root) redirect to /dav/ (what
//    iOS/macOS/DAVx5/Thunderbird discovery asks for).
//  - Only /dav and /.well-known/caldav are forwarded; nothing else on Vikunja is
//    reachable through this.

import http from 'node:http';
import https from 'node:https';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

export const isDavPath = (url) => /^\/dav(\/|\?|$)/.test(url ?? '');

/**
 * @param {{ target: string, timeoutMs?: number }} opts  target = Vikunja base URL
 */
export function createCaldavProxy({ target, timeoutMs = 30000 }) {
  const base = new URL(target);
  const client = base.protocol === 'https:' ? https : http;
  const basePath = base.pathname.replace(/\/$/, '');

  return function caldavProxy(req, res, next) {
    // Discovery: RFC 6764 well-known, and clients that PROPFIND the server root.
    if (req.url === '/.well-known/caldav' || req.url.startsWith('/.well-known/caldav?') || (req.method === 'PROPFIND' && req.url === '/')) {
      res.statusCode = 301;
      res.setHeader('Location', '/dav/');
      res.end();
      return;
    }
    if (!isDavPath(req.url)) return next();

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers.host = base.host;
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? (req.socket.encrypted ? 'https' : 'http');

    const upstream = client.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path: basePath + req.url, headers, timeout: timeoutMs },
      (up) => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
        // A redirect that names Vikunja's own origin must point back at the gateway.
        if (typeof out.location === 'string' && out.location.startsWith(base.origin)) out.location = out.location.slice(base.origin.length) || '/';
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
    upstream.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`CalDAV backend (Vikunja) is unreachable: ${err.message}\n`);
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };
}

export default createCaldavProxy;
