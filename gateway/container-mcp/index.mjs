// Entry point for the containerized dayGLANCE MCP server.
//
// Runs inside the dayglance container image (see Dockerfile) alongside nginx.
// Config via env:
//   DAYGLANCE_MCP_PORT    port to bind (default 7893)
//   DAYGLANCE_MCP_TOKEN   bearer token required on every request (recommended;
//                         empty = open, which is only safe on a private net)
//   DAYGLANCE_STATE_FILE  path to the JSON state document (default
//                         /data/dayglance-state.json)
//   TZ                    IANA timezone used to resolve "today" (default: host)

import { startDayglanceMcpServer } from './server.mjs';

const srv = startDayglanceMcpServer();
if (!srv) {
  console.error('[dayGLANCE MCP] failed to start; exiting.');
  process.exit(1);
}

function shutdown() {
  console.log('[dayGLANCE MCP] shutting down');
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
