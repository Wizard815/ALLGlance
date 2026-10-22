// Small JSON fetch helper using the global fetch (Node >= 18).
// Wraps errors, supports a timeout, and normalizes non-2xx responses.

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: unknown, timeoutMs?: number, follow?: number }} [opts]
 */
export async function fetchJson(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 15000, follow = 2 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = { method, headers, signal: controller.signal, follow };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${url} -> ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { text: await res.text() };
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export default fetchJson;
