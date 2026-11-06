// Omi (Wizard815/omi-local): the wearable's conversations, memories, action items and
// day summaries, surfaced through the gateway so one MCP endpoint covers the whole day.
//
// Omi runs its own Streamable HTTP MCP server at <OMI_URL>/v1/mcp (bearer `omi_mcp_...`
// key, created in the Omi app under Settings -> Developer -> MCP). This adapter proxies
// its tools as omi_* (the way VikunjaAdapter surfaces vikunja_native_*) and adds the
// day summary to allglance_get_day. It owns no tasks here: Omi's action items reach
// Vikunja through CalDAV (Omi's own sync against /dav) or the allglance task
// integration, so listing them again would show every task twice.

import { BaseAdapter } from './BaseAdapter.js';
import McpHttpClient from '../transport/McpHttpClient.js';
import { fetchJson } from '../lib/fetch.js';

const PREFIX = 'omi_';
const TOOLS_TTL_MS = 5 * 60 * 1000;
// The everyday set. OMI_TOOLS=all exposes every tool Omi's key allows.
const CORE_TOOLS = new Set([
  'get_daily_summaries',
  'get_conversations',
  'search_conversations',
  'get_memories',
  'search_memories',
  'get_action_items',
]);

const ONE_LINE = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export class OmiAdapter extends BaseAdapter {
  source = 'omi';
  label = 'Omi';
  #baseUrl;
  #token;
  #mode;
  #client;
  #cache = { at: 0, tools: [] };
  #warned = false;

  constructor(opts) {
    super(opts);
    const cfg = opts.config.omi ?? {};
    this.enabled = Boolean(cfg.enabled) && Boolean(cfg.url);
    this.#baseUrl = String(cfg.url ?? '').replace(/\/+$/, '');
    this.#token = cfg.token ?? '';
    this.#mode = cfg.tools ?? 'core';
    this.#client = new McpHttpClient({
      url: `${this.#baseUrl}/v1/mcp`,
      token: this.#token,
      clientName: 'allglance-gateway',
    });
  }

  /** Omi's MCP tools, prefixed omi_, cached for five minutes. Never throws. */
  async dynamicTools() {
    if (!this.enabled || this.#mode === 'off') return [];
    if (Date.now() - this.#cache.at < TOOLS_TTL_MS) return this.#cache.tools;
    let tools = [];
    try {
      const listed = await this.#client.listTools();
      tools = listed
        .filter((t) => this.#mode === 'all' || CORE_TOOLS.has(t.name))
        .map((t) => ({
          name: `${PREFIX}${t.name}`,
          description: `[Omi: the wearable's conversations, memories, tasks and day summaries.] ${ONE_LINE(t.description)}`,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          handler: async (args) => this.#client.callTool(t.name, args ?? {}),
        }));
      this.#warned = false;
    } catch (err) {
      if (!this.#warned) {
        console.warn(`[omi] MCP tools unavailable: ${err.message}`);
        this.#warned = true;
      }
    }
    this.#cache = { at: Date.now(), tools };
    return tools;
  }

  /**
   * Omi's own summary of one date (its get_daily_summaries tool), compact, for
   * allglance_get_day: null when Omi has no summary for that day yet. Throws when
   * Omi cannot be reached (the caller marks it unavailable).
   */
  async daySummary(date) {
    const out = await this.#client.callTool('get_daily_summaries', { start_date: date, end_date: date, limit: 1 });
    const payload = out?.structuredContent ?? parseText(out);
    const list = Array.isArray(payload) ? payload : payload?.daily_summaries;
    const r = Array.isArray(list) ? list.find((x) => x && (!x.date || x.date === date)) : null;
    if (!r) return null;
    const texts = (arr, key) => (Array.isArray(arr) ? arr.map((x) => x?.[key]).filter(Boolean) : []);
    return {
      headline: r.headline ?? '',
      overview: r.overview ?? '',
      highlights: (Array.isArray(r.highlights) ? r.highlights : []).map((h) => h.topic ?? h.summary).filter(Boolean),
      decisions: texts(r.decisions_made, 'decision'),
      open_questions: texts(r.unresolved_questions, 'question'),
      conversations: r.stats?.total_conversations,
    };
  }

  async status() {
    try {
      await fetchJson(`${this.#baseUrl}/health`, { timeoutMs: 5000 });
      const tools = (await this.dynamicTools()).length;
      return { ok: true, authenticated: !!this.#token, label: this.label, mcpTools: tools };
    } catch (err) {
      return { ok: false, error: err.message, label: this.label };
    }
  }
}

/** Omi answers tools/call with one text block holding the JSON result. */
function parseText(out) {
  const text = out?.content?.find?.((c) => c.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export default OmiAdapter;
