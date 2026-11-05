// Minimal MCP client for Streamable-HTTP servers (tools/list + tools/call).
//
// Used for Vikunja's built-in MCP (/api/v2/mcp, Vikunja 2.7+), which is
// stateless (no session id) and replies as text/event-stream or JSON. If a
// server does issue an `mcp-session-id` header it is remembered and echoed.

export class McpHttpClient {
  /**
   * @param {{ url: string, token?: string, timeoutMs?: number, clientName?: string }} opts
   */
  constructor({ url, token = '', timeoutMs = 15000, clientName = 'allglance-gateway' }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.clientName = clientName;
    this.sessionId = null;
    this.initialized = false;
    this.nextId = 1;
  }

  async #post(body) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${body.method} -> ${res.status} ${text.slice(0, 160)}`);
    }
    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { return JSON.parse(line.slice(5).trim()); } catch { /* keep scanning */ }
      }
      throw new Error(`MCP ${body.method}: no JSON payload in the event stream`);
    }
    return JSON.parse(text);
  }

  async #request(method, params = {}) {
    const msg = await this.#post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (msg?.error) throw new Error(`MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg?.result ?? {};
  }

  async #ensureInitialized() {
    if (this.initialized) return;
    await this.#request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '0.1.0' },
    });
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    this.initialized = true;
  }

  /** Run `fn`, re-initializing once if the server dropped our session/state. */
  async #withInit(fn) {
    await this.#ensureInitialized();
    try {
      return await fn();
    } catch (err) {
      if (!/ -> (400|404) /.test(err.message)) throw err;
      this.initialized = false;
      this.sessionId = null;
      await this.#ensureInitialized();
      return fn();
    }
  }

  async listTools() {
    return this.#withInit(async () => (await this.#request('tools/list')).tools ?? []);
  }

  /** @returns {Promise<{content?: unknown[], structuredContent?: unknown, isError?: boolean}>} */
  async callTool(name, args = {}) {
    return this.#withInit(() => this.#request('tools/call', { name, arguments: args }));
  }
}

export default McpHttpClient;
