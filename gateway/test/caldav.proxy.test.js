// The gateway's CalDAV front door: a transparent proxy to Vikunja's /dav.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createCaldavProxy, isDavPath } from '../src/caldavProxy.js';

function listen(handler) {
  return new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
}
const port = (s) => s.address().port;

async function rig() {
  const seen = [];
  const upstream = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/dav/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${port(upstream)}/dav/projects/2` }); res.end(); return; }
      if (req.url === '/dav/projects/2/x.ics' && req.method === 'PUT') { res.writeHead(201, { ETag: '"abc"', Connection: 'close' }); res.end(); return; }
      res.writeHead(req.method === 'PROPFIND' || req.method === 'REPORT' ? 207 : 200, { 'content-type': 'application/xml; charset=utf-8', DAV: '1, calendar-access', ETag: '"e1"' });
      res.end(`<d:multistatus>${req.method}</d:multistatus>`);
    });
  });
  const app = express();
  app.use(createCaldavProxy({ target: `http://127.0.0.1:${port(upstream)}` }));
  app.use(express.json());
  app.get('/health', (_q, r) => r.json({ ok: true }));
  const gw = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { seen, base: `http://127.0.0.1:${port(gw)}`, close: () => { upstream.close(); gw.close(); } };
}

test('isDavPath only matches /dav', () => {
  for (const ok of ['/dav', '/dav/', '/dav/projects/2', '/dav?x=1']) assert.equal(isDavPath(ok), true, ok);
  for (const no of ['/davinci', '/api/allglance/tasks', '/health', '/x/dav/']) assert.equal(isDavPath(no), false, no);
});

test('WebDAV/CalDAV verbs, headers and bodies pass through; Basic auth reaches the backend untouched', async () => {
  const t = await rig();
  try {
    const propfind = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
    const r = await fetch(`${t.base}/dav/projects`, { method: 'PROPFIND', headers: { Depth: '1', 'content-type': 'application/xml', authorization: 'Basic ZGVtbzpwdw==' }, body: propfind });
    assert.equal(r.status, 207);
    assert.match(await r.text(), /PROPFIND/);
    assert.equal(r.headers.get('dav'), '1, calendar-access');
    assert.equal(r.headers.get('etag'), '"e1"');
    const s = t.seen.at(-1);
    assert.equal(s.method, 'PROPFIND');
    assert.equal(s.url, '/dav/projects');
    assert.equal(s.headers.depth, '1');
    assert.equal(s.headers.authorization, 'Basic ZGVtbzpwdw==');
    assert.equal(s.body, propfind);
    assert.equal(s.headers['x-forwarded-host'].startsWith('127.0.0.1:'), true);

    for (const m of ['REPORT', 'OPTIONS', 'DELETE', 'PROPPATCH', 'MKCOL', 'GET']) {
      const rr = await fetch(`${t.base}/dav/projects/2`, { method: m, body: ['REPORT', 'PROPPATCH', 'MKCOL'].includes(m) ? '<x/>' : undefined });
      assert.ok(rr.status < 300, `${m} -> ${rr.status}`);
      assert.equal(t.seen.at(-1).method, m);
    }
    const put = await fetch(`${t.base}/dav/projects/2/x.ics`, { method: 'PUT', headers: { 'content-type': 'text/calendar', 'If-None-Match': '*' }, body: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
    assert.equal(put.status, 201);
    assert.equal(put.headers.get('etag'), '"abc"');
    assert.equal(t.seen.at(-1).headers['if-none-match'], '*');
    assert.equal(t.seen.at(-1).body, 'BEGIN:VCALENDAR\nEND:VCALENDAR');
  } finally { t.close(); }
});

test('well-known discovery redirects to /dav/; other paths are not proxied; backend redirects point back at the gateway', async () => {
  const t = await rig();
  try {
    const wk = await fetch(`${t.base}/.well-known/caldav`, { redirect: 'manual' });
    assert.equal(wk.status, 301);
    assert.equal(wk.headers.get('location'), '/dav/');
    const root = await fetch(`${t.base}/`, { method: 'PROPFIND', redirect: 'manual' });
    assert.equal(root.status, 301, 'clients that PROPFIND the server root are sent to /dav/');
    assert.equal(root.headers.get('location'), '/dav/');
    const before = t.seen.length;
    assert.equal((await fetch(`${t.base}/health`)).status, 200);
    assert.equal((await fetch(`${t.base}/api/v2/tasks`)).status, 404, 'Vikunja REST is not exposed through the gateway');
    assert.equal(t.seen.length, before, 'nothing reached the backend');
    const red = await fetch(`${t.base}/dav/redirect`, { redirect: 'manual' });
    assert.equal(red.status, 302);
    assert.equal(red.headers.get('location'), '/dav/projects/2');
  } finally { t.close(); }
});

test('backend down -> a clear 502, not a hang or a crash', async () => {
  const app = express();
  app.use(createCaldavProxy({ target: 'http://127.0.0.1:9' }));
  const gw = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${port(gw)}/dav/`, { method: 'PROPFIND' });
    assert.equal(r.status, 502);
    assert.match(await r.text(), /Vikunja\) is unreachable/);
  } finally { gw.close(); }
});
