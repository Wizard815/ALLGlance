// Standalone Node.js proxy server for the Docker deployment.
// Handles /api/webdav-proxy/ and /api/calendar-proxy/ — identical logic to
// the Vercel serverless functions, but running as a plain http.Server so
// that nginx can forward requests to it after URL-decoding the query string.
// (nginx's $arg_* variables are not URL-decoded, so proxy_pass receives the
// encoded value "https%3A%2F%2F..." which it rejects as an invalid prefix.)
//
// SECURITY POSTURE (see issue #1664 — this used to say "intentionally OPEN"):
//
// There is no origin allowlist and no rate limiting here, because this server
// only ever runs inside the self-hosted image, bound to 127.0.0.1 behind the
// bundled nginx. TARGET addresses, however, are now checked, by the same policy
// module the hosted Vercel functions use (api/_ssrfGuard.mjs):
//
//   • PRIVATE / LAN targets are ALLOWED by default. Self-hosters legitimately
//     point this at a NAS on 192.168.x.x, a Docker host on 10.x, a Tailscale
//     node on 100.64/10, or a service on the same host. That is the whole point
//     of the self-hosted image and nothing here changes it. Deployments that
//     want the hosted lock-down can set WEBDAV_PROXY_BLOCK_PRIVATE=1.
//   • METADATA, link-local, multicast, reserved and benchmarking ranges are
//     ALWAYS refused, whatever that variable says. Nothing serves WebDAV or
//     CalDAV there, and 169.254.169.254 hands out cloud instance credentials to
//     anyone who can reach this container. Previously it did.
//
// This is still an unauthenticated relay to anything else on your network, so
// do NOT expose the container directly to the public internet without putting
// authentication or an access-controlled reverse proxy in front of it.
//
// Run as ESM (.mjs) rather than .js: the image copies bare files into /app with
// no package.json beside them, where Node reads .js as CommonJS and the shared
// guard's `import` would fail. The Dockerfile mirrors the repo's directory
// layout (/app/docker/ and /app/api/) so this relative import resolves the same
// way in the image as it does in a checkout.

import http from 'node:http';
import { safeRequest, SsrfError } from '../api/_ssrfGuard.mjs';

// Private/LAN targets stay reachable unless a deployment opts into the hosted
// lock-down. Same variable name lifeGLANCE uses, so anyone self-hosting more
// than one GLANCE app configures them identically.
const BLOCK_PRIVATE = process.env.WEBDAV_PROXY_BLOCK_PRIVATE === '1' ||
  process.env.WEBDAV_PROXY_BLOCK_PRIVATE === 'true';
const ALLOW_PRIVATE = !BLOCK_PRIVATE;
if (BLOCK_PRIVATE) {
  process.stdout.write('[proxy] WEBDAV_PROXY_BLOCK_PRIVATE set — private/LAN targets will be refused\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleWebDAVProxy(req, res, targetUrl) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-WebDAV-Auth, Content-Type, Depth, If-Match, If-None-Match',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const headers = {};

  const bodylessMethods = new Set(['GET', 'HEAD', 'PROPFIND', 'DELETE', 'MKCOL']);
  if (!bodylessMethods.has(req.method)) {
    headers['Content-Type'] = req.headers['content-type'] || 'application/octet-stream';
  }
  if (req.headers['x-webdav-auth']) {
    headers['Authorization'] = req.headers['x-webdav-auth'];
  }
  if (req.headers['depth'] !== undefined) {
    headers['Depth'] = req.headers['depth'];
  }
  if (req.headers['if-match'])      headers['If-Match']      = req.headers['if-match'];
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const rawBody = await readBody(req);
    if (rawBody) body = rawBody;
  }

  try {
    const response = await safeRequest(targetUrl, {
      method: req.method, headers, body, allowPrivate: ALLOW_PRIVATE,
    });
    const resHeaders = {
      'Content-Type': response.headers['content-type'] || 'text/plain',
      'Cache-Control': 'no-store',
    };
    if (response.headers.etag) resHeaders['ETag'] = response.headers.etag;
    res.writeHead(response.status, resHeaders);
    res.end(response.body);
  } catch (err) {
    // A policy refusal (including on a redirect hop) carries its own status;
    // anything else is an ordinary upstream failure.
    if (err instanceof SsrfError) return sendJson(res, err.status, { error: err.message });
    sendJson(res, 502, { error: 'Failed to proxy WebDAV request' });
  }
}

async function handleCalendarProxy(req, res, targetUrl) {
  const fetchHeaders = { Accept: 'text/calendar, text/plain, */*' };
  if (req.headers['x-calendar-auth']) {
    fetchHeaders['Authorization'] = req.headers['x-calendar-auth'];
  }

  try {
    const response = await safeRequest(targetUrl, {
      headers: fetchHeaders, allowPrivate: ALLOW_PRIVATE,
    });
    res.writeHead(response.status, {
      'Content-Type': response.headers['content-type'] || 'text/plain',
      'Cache-Control': 'public, max-age=900, stale-while-revalidate=60',
    });
    res.end(response.body);
  } catch (err) {
    if (err instanceof SsrfError) return sendJson(res, err.status, { error: err.message });
    sendJson(res, 502, { error: 'Failed to fetch calendar' });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const targetUrl = parsed.searchParams.get('url'); // automatically URL-decoded

  const isWebDAV  = parsed.pathname.startsWith('/api/webdav-proxy');
  const isCalendar = parsed.pathname.startsWith('/api/calendar-proxy');

  if (!isWebDAV && !isCalendar) {
    res.writeHead(404);
    return res.end();
  }

  if (!targetUrl) return sendJson(res, 400, { error: 'Missing url parameter' });

  if (isWebDAV)   return handleWebDAVProxy(req, res, targetUrl);
  if (isCalendar) return handleCalendarProxy(req, res, targetUrl);
});

server.listen(3001, '127.0.0.1', () => {
  process.stdout.write('Proxy server listening on 127.0.0.1:3001\n');
});
