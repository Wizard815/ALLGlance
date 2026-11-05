// Entry point for the containerized dayGLANCE MCP server.
//
// Runs inside the dayglance container image (see Dockerfile) alongside nginx.
// Config via env:
//   DAYGLANCE_MCP_PORT    port to bind (default 7893)
//   DAYGLANCE_MCP_TOKEN   bearer token required on every request (recommended;
//                         empty = open, which is only safe on a private net)
//   DAYGLANCE_SYNC_FILE   path to dayGLANCE's WebDAV sync snapshot
//                         (dayglance-sync.json). When set, the MCP reads and
//                         writes the app's live data through it.
//   DAYGLANCE_SYNC_PASSPHRASE  the sync passphrase set in dayGLANCE, needed only
//                         when end-to-end encryption is on (to decrypt/re-encrypt).
//   DAYGLANCE_STATE_FILE  (fallback) path to the JSON state document (default
//                         /data/dayglance-state.json)
//   DAYGLANCE_EVENTS_ROOT shared WebDAV dir to keep intent event filenames readable
//                         across the GLANCE apps (see eventNormalizer.mjs)
//   TZ                    IANA timezone used to resolve "today" (default: host)

import { startDayglanceMcpServer } from './server.mjs';
import { startEventNormalizer } from './eventNormalizer.mjs';

const srv = startDayglanceMcpServer();
if (!srv) {
  console.error('[dayGLANCE MCP] failed to start; exiting.');
  process.exit(1);
}

// Intents hygiene (see eventNormalizer.mjs): make dayGLANCE's completion events
// readable by lastGLANCE. Needs the shared WebDAV directory mounted.
const eventsRoot = process.env.DAYGLANCE_EVENTS_ROOT;
const stopNormalizer = eventsRoot ? startEventNormalizer(eventsRoot) : () => {};
if (eventsRoot) console.log(`[dayGLANCE MCP] normalizing intent event filenames under ${eventsRoot}`);

function shutdown() {
  stopNormalizer();
  console.log('[dayGLANCE MCP] shutting down');
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
