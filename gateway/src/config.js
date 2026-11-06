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
    // When set, /api/allglance/* and /mcp require `Authorization: Bearer <token>`.
    token: env('GATEWAY_TOKEN', ''),
  },
  vikunja: {
    url: env('VIKUNJA_URL', 'http://vikunja:3456'),
    token: env('VIKUNJA_TOKEN', ''),
    caldavUrl: env('VIKUNJA_CALDAV_URL', ''),
    enabled: enabled(env('ENABLE_VIKUNJA', 'true')),
    // Vikunja's built-in MCP (Vikunja 2.7+, /api/v2/mcp). Its tools are exposed
    // through the gateway as vikunja_native_*. The token needs the `mcp.access`
    // permission; it defaults to VIKUNJA_TOKEN, so one token with that scope is enough.
    mcp: {
      enabled: enabled(env('ENABLE_VIKUNJA_MCP', 'true')),
      token: env('VIKUNJA_MCP_TOKEN', ''),
      // Which native tools to expose: 'meta' = find_action / do_action /
      // filter_syntax only (default; reaches everything without 11 extra tools),
      // 'all' = every native tool, 'off' = none.
      tools: env('VIKUNJA_NATIVE_TOOLS', 'meta'),
    },
    // Project new tasks land in when the caller names none (id). Empty = the
    // first project Vikunja lists (normally Inbox).
    defaultProjectId: env('VIKUNJA_DEFAULT_PROJECT_ID', ''),
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
  // CalDAV front door: serve Vikunja's /dav through the gateway (ENABLE_CALDAV_PROXY=false to turn off).
  caldav: {
    proxy: enabled(env('ENABLE_CALDAV_PROXY', 'true')),
  },
  // Shared WebDAV sync directory (the dayglance-sync service's data dir, mounted
  // read-only). Every GLANCE app syncs a snapshot file here; with the shared
  // sync passphrase the gateway reads lastGLANCE and lifeGLANCE (and could read
  // dayGLANCE) straight from it. Empty dir = snapshot reading disabled and the
  // adapters fall back to the Playwright reader.
  sync: {
    dir: env('GLANCE_SYNC_DIR', ''),
    passphrase: env('GLANCE_SYNC_PASSPHRASE', ''),
    // Exact path of dayGLANCE's snapshot (same value the dayglance-mcp service uses).
    // Optional: without it the file is searched for under `dir`.
    dayglanceFile: env('DAYGLANCE_SYNC_FILE', ''),
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
