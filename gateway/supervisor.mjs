// Process supervisor for the single `allglance` container.
//
// One container, three services, each its own process so a crash in one cannot
// take down the others:
//   sync           the WebDAV server the GLANCE apps sync to (hacdias/webdav)
//   dayglance-mcp  dayGLANCE's MCP, serving the app's data + the intent-event fixer
//   gateway        the front door: MCP, REST and CalDAV
//
// Crashed children are restarted with a capped backoff (reset after a stable
// run); SIGTERM/SIGINT stop everything cleanly. This process is PID 1.

import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * @param {Array<{ name: string, cmd: string, args?: string[], env?: object }>} specs
 * @param {{ spawn?: Function, log?: (m: string) => void, minBackoffMs?: number, maxBackoffMs?: number, stableMs?: number, killTimeoutMs?: number }} [opts]
 */
export function supervise(specs, opts = {}) {
  const {
    spawn = nodeSpawn, log = (m) => console.log(m),
    minBackoffMs = 1000, maxBackoffMs = 15000, stableMs = 30000, killTimeoutMs = 5000,
  } = opts;
  let stopping = false;
  const state = new Map();

  const prefix = (name, stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { log(`[${name}] ${buf.slice(0, i)}`); buf = buf.slice(i + 1); }
    });
    stream.on('end', () => { if (buf) log(`[${name}] ${buf}`); });
  };

  function start(spec) {
    const st = state.get(spec.name) ?? { failures: 0, timer: null, child: null };
    state.set(spec.name, st);
    const startedAt = Date.now();
    const child = spawn(spec.cmd, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    st.child = child;
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    if (child.stdout) prefix(spec.name, child.stdout);
    if (child.stderr) prefix(spec.name, child.stderr);
    log(`[supervisor] started ${spec.name}`);
    child.on('error', (err) => log(`[supervisor] ${spec.name} could not start: ${err.message}`));
    child.on('exit', (code, signal) => {
      st.child = null;
      if (stopping) return;
      st.failures = Date.now() - startedAt >= stableMs ? 1 : st.failures + 1;
      const wait = Math.min(maxBackoffMs, minBackoffMs * 2 ** (st.failures - 1));
      log(`[supervisor] ${spec.name} exited (${signal ?? code}); restarting in ${wait} ms`);
      st.timer = setTimeout(() => { if (!stopping) start(spec); }, wait);
    });
  }

  for (const spec of specs) start(spec);

  const stop = () => new Promise((resolve) => {
    if (stopping) return resolve();
    stopping = true;
    const live = [...state.values()].filter((s) => s.child);
    for (const s of state.values()) clearTimeout(s.timer);
    if (!live.length) return resolve();
    let left = live.length;
    const done = () => { if (--left === 0) resolve(); };
    for (const s of live) {
      const t = setTimeout(() => s.child?.kill('SIGKILL'), killTimeoutMs);
      s.child.once('exit', () => { clearTimeout(t); done(); });
      s.child.kill('SIGTERM');
    }
  });

  return { stop, state };
}

// ---- entrypoint -----------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const node = process.execPath;
  const { stop } = supervise([
    { name: 'sync', cmd: process.env.WEBDAV_BIN ?? '/usr/local/bin/webdav', args: ['--config', process.env.WEBDAV_CONFIG ?? '/app/webdav.yml'] },
    { name: 'dayglance-mcp', cmd: node, args: ['container-mcp/index.mjs'], env: { DAYGLANCE_MCP_BIND: '127.0.0.1' } },
    { name: 'gateway', cmd: node, args: ['src/server.js'], env: { SYNC_WEBDAV_PORT: process.env.SYNC_WEBDAV_PORT ?? '6065' } },
  ]);
  const shutdown = async (sig) => { console.log(`[supervisor] ${sig}: stopping`); await stop(); process.exit(0); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
