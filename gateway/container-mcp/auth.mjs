// Bearer-token auth for the containerized dayGLANCE MCP.
// Ported verbatim (logic) from apps/dayglance/electron/mcpAuth.ts.

import { createHash, timingSafeEqual } from 'node:crypto';

export function checkBearerToken(header, expectedToken) {
  if (header === undefined) return { ok: false, reason: 'missing-header' };
  if (Array.isArray(header)) return { ok: false, reason: 'malformed-header' };
  const match = /^Bearer[ ]+(.+)$/i.exec(header);
  if (!match) return { ok: false, reason: 'malformed-header' };

  const presented = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  if (!timingSafeEqual(presented, expected)) return { ok: false, reason: 'wrong-token' };
  return { ok: true };
}

export function unauthorizedResponse() {
  return {
    status: 401,
    headers: { 'content-type': 'application/json', 'WWW-Authenticate': 'Bearer' },
    body: JSON.stringify({ error: 'unauthorized' }),
  };
}
