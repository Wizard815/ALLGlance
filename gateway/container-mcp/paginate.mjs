// Pagination for the containerized dayGLANCE MCP list tools.
// Ported verbatim (logic) from apps/dayglance/electron/mcpPagination.ts.

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

const CURSOR_PREFIX = 'dgc1.';

export function encodeCursor(offset, filterKey) {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ o: offset, f: filterKey }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
    const offset = parsed.o;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null;
    if (typeof parsed.f !== 'string') return null;
    return { offset, filterKey: parsed.f };
  } catch {
    return null;
  }
}

export function paginate(items, opts) {
  let limit = DEFAULT_LIST_LIMIT;
  if (opts.limit !== undefined) {
    if (typeof opts.limit !== 'number' || !Number.isInteger(opts.limit) || opts.limit < 1) {
      return { ok: false, reason: `limit must be an integer >= 1, got ${JSON.stringify(opts.limit)}` };
    }
    if (opts.limit > MAX_LIST_LIMIT) {
      return { ok: false, reason: `limit must be <= ${MAX_LIST_LIMIT}, got ${opts.limit}` };
    }
    limit = opts.limit;
  }

  let offset = 0;
  if (opts.cursor !== undefined) {
    if (typeof opts.cursor !== 'string') {
      return { ok: false, reason: 'cursor must be a string from a previous response' };
    }
    const decoded = decodeCursor(opts.cursor);
    if (decoded === null) {
      return { ok: false, reason: 'cursor is not valid; use the next_cursor from a previous response' };
    }
    if (decoded.filterKey !== opts.filterKey) {
      return {
        ok: false,
        reason:
          `cursor was issued under a different filter (cursor: ${decoded.filterKey}; this call: ${opts.filterKey}). ` +
          'Changing filters mid-pagination is not supported; restart with a fresh call and no cursor.',
      };
    }
    offset = decoded.offset;
  }

  const page = items.slice(offset, offset + limit);
  const truncated = offset + limit < items.length;
  return {
    ok: true,
    items: page,
    truncated,
    nextCursor: truncated ? encodeCursor(offset + limit, opts.filterKey) : null,
    total: items.length,
  };
}
