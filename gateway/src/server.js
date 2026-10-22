// AllGLANCE gateway entry point.
//
// Starts the Express REST server + MCP server, registers the gateway's REST
// routes and MCP router, and boots the dayGLANCE transport (MCP when available,
// otherwise the Playwright fallback). See DESIGN.md §6-8.

import express from 'express';
import config, { enabledAdapters } from './config.js';
import Gateway from './gateway.js';
import { createMcpRouter } from './mcp/server.js';
import DayglanceMcpClient from './transport/DayglanceMcpClient.js';

function buildServer() {
  const gateway = new Gateway();
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Wire dayGLANCE's transport onto its adapter. Prefer the desktop MCP path
  // (fast, loopback); fall back to Playwright when it isn't reachable.
  const dayAdapter = gateway.adapters().find((a) => a.source === 'dayglance');
  if (dayAdapter) {
    const mcp = new DayglanceMcpClient({
      host: config.dayglance.mcpHost,
      port: config.dayglance.mcpPort,
      token: config.dayglance.mcpToken || undefined,
    });
    mcp.status().then((s) => {
      if (s?.ok) {
        console.log('[gateway] dayGLANCE MCP reachable on', config.dayglance.mcpPort, '— using transport A');
        dayAdapter.setTransport({ read: (date) => mcp.read(date), mode: 'mcp' });
      } else {
        console.log('[gateway] dayGLANCE MCP unavailable — Playwright fallback active');
        dayAdapter.setTransport({ read: () => dayAdapter.readLocalStorage() }, 'playwright');
      }
    });
  }

  // Health + introspection.
  app.get('/health', async (_req, res) => {
    res.json(await gateway.health());
  });

  // REST gateway routes.
  gateway.registerRoutes(app);

  // MCP front door.
  app.use(createMcpRouter(gateway));

  return { app, gateway };
}

async function main() {
  const { app } = buildServer();
  const { port, host } = config.server;
  app.listen(port, host, () => {
    console.log(`[gateway] AllGLANCE gateway listening on http://${host}:${port}`);
    console.log(`[gateway] enabled adapters: ${enabledAdapters().join(', ') || 'none'}`);
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  main().catch((err) => {
    console.error('[gateway] fatal:', err);
    process.exit(1);
  });
}

export { buildServer };
