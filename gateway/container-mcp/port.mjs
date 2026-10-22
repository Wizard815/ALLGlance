// Port resolution for the containerized dayGLANCE MCP listener.
// Ported verbatim (logic) from apps/dayglance/electron/mcpPort.ts.
//
// NOTE: unlike the desktop app (loopback-only), the container listener binds
// 0.0.0.0 so the gateway on the compose network can reach it. The port rules
// are the same: exactly one port, no scanning, invalid overrides refused.

export const DEFAULT_MCP_PORT = 7893;

export function resolveMcpPort(override) {
  if (override === undefined || override === null) return { ok: true, port: DEFAULT_MCP_PORT };

  let value;
  if (typeof override === 'number') {
    value = override;
  } else if (typeof override === 'string') {
    const trimmed = override.trim();
    if (trimmed === '') return { ok: true, port: DEFAULT_MCP_PORT };
    if (!/^\d+$/.test(trimmed)) return { ok: false, reason: `Invalid MCP port override: ${JSON.stringify(override)}` };
    value = Number(trimmed);
  } else {
    return { ok: false, reason: `Invalid MCP port override of type ${typeof override}` };
  }

  if (!Number.isInteger(value)) return { ok: false, reason: `Invalid MCP port override: ${value} is not an integer` };
  if (value === 0) return { ok: false, reason: 'MCP port 0 (ephemeral) would move on every launch; pick a fixed port' };
  if (value < 1 || value > 65535) return { ok: false, reason: `Invalid MCP port override: ${value} is outside 1-65535` };
  return { ok: true, port: value };
}

export function describeBindFailure(port, err) {
  if (err.code === 'EADDRINUSE') {
    return `MCP server could not start: port ${port} is already in use by another process. Pick a different port explicitly.`;
  }
  return `MCP server could not start on 0.0.0.0:${port}: ${err.code ?? err.message ?? 'unknown error'}`;
}
