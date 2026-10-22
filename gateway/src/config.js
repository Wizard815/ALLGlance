// Runtime configuration for the AllGLANCE gateway.
//
// Values resolve from environment variables with sensible defaults so the
// gateway runs out of the box against the standard docker/ compose network
// (service names as hostnames). Override via .env or the container
// environment (e.g. Unraid appdata config).

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const enabled = (v) =>
  v === undefined
    ? true
    : /^(1|yes|true|on)$/i.test(String(v));

export const config = {
  server: {
    port: Number(env('GATEWAY_PORT', 8090)),
    host: env('GATEWAY_HOST', '0.0.0.0'),
  },
  vikunja: {
    url: env('VIKUNJA_URL', 'http://vikunja:3456'),
    token: env('VIKUNJA_TOKEN', ''),
    caldavUrl: env('VIKUNJA_CALDAV_URL', ''),
    enabled: enabled(env('ENABLE_VIKUNJA', 'true')),
  },
  dayglance: {
    // Host of dayGLANCE's MCP listener. In the container stack this is the
    // dayglance-mcp service; for the desktop app it is 127.0.0.1 (loopback).
    mcpHost: env('DAYGLANCE_MCP_HOST', '127.0.0.1'),
    // MCP listener port (electron/mcpPort.ts DEFAULT_MCP_PORT = 7893).
    mcpPort: Number(env('DAYGLANCE_MCP_PORT', 7893)),
    // dayGLANCE's MCP is bearer-token gated (electron/mcpAuth.ts; the
    // container port mirrors it). Set DAYGLANCE_MCP_TOKEN in .env.allglance so
    // both the dayglance-mcp service and this gateway share it. When empty the
    // client falls back to the desktop discovery file (electron/mcpDiscovery.ts).
    mcpToken: env('DAYGLANCE_MCP_TOKEN', ''),
    // Docker web build base URL used by the Playwright reader fallback.
    webUrl: env('DAYGLANCE_WEB_URL', 'http://dayglance:6767'),
    enabled: enabled(env('ENABLE_DAYGLANCE', 'true')),
  },
  lastglance: {
    webUrl: env('LASTGLANCE_WEB_URL', 'http://lastglance:3000'),
    enabled: enabled(env('ENABLE_LASTGLANCE', 'true')),
  },
  lifeglance: {
    webUrl: env('LIFELANCE_WEB_URL', 'http://lifeglance:6868'),
    enabled: enabled(env('ENABLE_LIFELANCE', 'true')),
  },
  playwright: {
    // Launch the browser once and reuse it; GC between runs for cleanliness.
    headless: enabled(env('PLAYWRIGHT_HEADLESS', 'true')),
    timeoutMs: Number(env('PLAYWRIGHT_TIMEOUT_MS', 30000)),
  },
};

/** Resolve the effective enabled-set of adapters for logging/health. */
export function enabledAdapters() {
  return Object.entries({
    vikunja: config.vikunja.enabled,
    dayglance: config.dayglance.enabled,
    lastglance: config.lastglance.enabled,
    lifeglance: config.lifeglance.enabled,
  })
    .filter(([, v]) => v)
    .map(([name]) => name);
}

export default config;
