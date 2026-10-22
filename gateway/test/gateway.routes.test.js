// Tests that the REST gateway registers and serves the documented endpoints,
// including /chores and /milestones added to DESIGN.md §7. These run without a
// browser by stubbing the gateway's read* methods, so they exercise the route
// wiring + response shape rather than the Playwright-backed adapters.
import { ok, equal } from 'node:assert/strict';
import { describe, it } from 'node:test';

// A fake Express app that records (method, path, handler) so tests can invoke
// the handlers directly — no server, no network.
function makeFakeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, handler) => {
      routes.push({ method, path, handler });
    };
  }
  app.routes = routes;
  app.find = (method, path) =>
    routes.find((r) => r.method === method && r.path === path)?.handler;
  return app;
}

// Build a Gateway whose read* methods return canned data. Gateway is a real
// class but we never call adapters(); we replace its read* methods after
// construction so no browser/adapter is involved.
import Gateway from '../src/gateway.js';

function buildGateway() {
  // A real Gateway: its constructor loads the four adapters (no browser
  // needed at construction — that only happens when read* runs). We then
  // override the read* methods with canned data so no browser/adapter runs.
  const gw = new Gateway();
  gw.readChores = async () => [
    { source: 'lastglance', id: 'c1', title: 'Dishes', owner_id: 'me', completed: false, extra: {} },
  ];
  gw.readMilestones = async () => [
    { source: 'lifeglance', id: 'm1', title: 'Bought house', date: '2026-01-15', owner_id: null, extra: {} },
  ];
  return gw;
}

function callHandler(handler, pathParams, query, body) {
  let status = 200;
  let payload;
  const req = { params: pathParams ?? {}, query: query ?? {}, body: body ?? {} };
  const res = {
    json: (data) => {
      payload = data;
    },
    status: (code) => {
      status = code;
      return res;
    },
  };
  return handler(req, res).then(() => ({ status, payload }));
}

describe('REST gateway routes', () => {
  it('registers /chores and /milestones (plus the existing ones)', () => {
    const gw = buildGateway();
    const app = makeFakeApp();
    const returned = gw.registerRoutes(app, '/api/allglance');

    const paths = returned.map((r) => r);
    ok(paths.includes('/chores'), `expected /chores in registered routes; got ${paths.join(',')}`);
    ok(paths.includes('/milestones'), `expected /milestones in registered routes; got ${paths.join(',')}`);
    ok(paths.includes('/users') && paths.includes('/tasks') && paths.includes('/days/:date'));
  });

  it('GET /api/allglance/chores returns { chores }', async () => {
    const gw = buildGateway();
    const app = makeFakeApp();
    gw.registerRoutes(app, '/api/allglance');

    const handler = app.find('get', '/api/allglance/chores');
    ok(handler, 'chores route should be registered');
    console.error('DEBUG handler:', typeof handler, 'routes:', app.routes.map(r => r.method + ' ' + r.path));
    const { status, payload } = await callHandler(handler, {}, { owner: 'me' });
    equal(status, 200);
    equal(payload.chores.length, 1);
    equal(payload.chores[0].title, 'Dishes');
    equal(payload.chores[0].owner_id, 'me');
  });

  it('GET /api/allglance/milestones returns { milestones }', async () => {
    const gw = buildGateway();
    const app = makeFakeApp();
    gw.registerRoutes(app, '/api/allglance');

    const handler = app.find('get', '/api/allglance/milestones');
    ok(handler, 'milestones route should be registered');
    const { status, payload } = await callHandler(handler, {}, {});
    equal(status, 200);
    equal(payload.milestones.length, 1);
    equal(payload.milestones[0].title, 'Bought house');
    equal(payload.milestones[0].owner_id, null);
  });

  it('errors are reported with 502, not thrown', async () => {
    const gw = buildGateway();
    gw.readChores = async () => {
      throw new Error('boom');
    };
    const app = makeFakeApp();
    gw.registerRoutes(app, '/api/allglance');

    const handler = app.find('get', '/api/allglance/chores');
    const { status, payload } = await callHandler(handler, {}, {});
    equal(status, 502);
    equal(payload.error, 'boom');
  });
});
