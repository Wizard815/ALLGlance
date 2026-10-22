// Canonical inbox-filter resolution for the containerized dayGLANCE MCP.
// Ported verbatim (logic) from apps/dayglance/electron/mcpInboxFilter.ts.

export const INBOX_SCOPES = ['all', 'standalone', 'project'];

export function resolveInboxFilter(args) {
  const { scope, include_completed } = args;

  let scopeValue = 'all';
  if (scope !== undefined) {
    if (typeof scope !== 'string' || !INBOX_SCOPES.includes(scope)) {
      return { ok: false, message: `scope must be one of ${INBOX_SCOPES.map((s) => `"${s}"`).join(', ')}, got ${JSON.stringify(scope)}` };
    }
    scopeValue = scope;
  }

  let includeCompleted = true;
  if (include_completed !== undefined) {
    if (typeof include_completed !== 'boolean') {
      return { ok: false, message: `include_completed must be a boolean, got ${JSON.stringify(include_completed)}` };
    }
    includeCompleted = include_completed;
  }

  return {
    ok: true,
    filter: {
      scope: scopeValue,
      includeCompleted,
      key: `scope=${scopeValue};completed=${includeCompleted ? '1' : '0'}`,
    },
  };
}
