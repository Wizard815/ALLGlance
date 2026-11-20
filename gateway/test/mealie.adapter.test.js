// Mealie's meal plan in allglance_get_day. Its own file: MEALIE_URL has to be set before
// src/config.js is imported.
import { describe, it, before, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { createServer } from 'node:http';

let server, hits = [], mode = 'households';
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push({ path: u.pathname, auth: req.headers.authorization, start: u.searchParams.get('start_date') });
    res.setHeader('content-type', 'application/json');
    if (mode === 'down') { res.statusCode = 500; return res.end('{}'); }
    const want = mode === 'groups' ? '/api/groups/mealplans' : '/api/households/mealplans';
    if (u.pathname !== want) { res.statusCode = 404; return res.end('{"detail":"Not Found"}'); }
    const d = u.searchParams.get('start_date');
    res.end(JSON.stringify({ items: [
      { date: d, entryType: 'dinner', title: '', recipe: { name: 'Fish tacos', slug: 'fish-tacos' } },
      { date: d, entryType: 'breakfast', title: 'Pancakes', text: 'with berries' },
      { date: '2000-01-01', entryType: 'lunch', title: 'Not today' },
    ] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MEALIE_URL = `http://127.0.0.1:${server.address().port}/`;
  process.env.MEALIE_TOKEN = 'mealie-token';
  process.env.ENABLE_DAYGLANCE = 'false';
  process.env.ENABLE_LASTGLANCE = 'false';
  process.env.ENABLE_LIFELANCE = 'false';
  process.env.ENABLE_OMI = 'false';
});
after(() => server.close());

describe('Mealie in allglance_get_day', () => {
  let gw;
  before(async () => {
    const { Gateway } = await import('../src/gateway.js');
    gw = new Gateway();
    gw.readTasksDetailed = async () => ({ by: { vikunja: [], dayglance: [] }, unavailable: [] });
  });

  it('adds that day\'s meals, breakfast first, with the recipe', async () => {
    const day = await gw.getDay('2026-11-20');
    deepEqual(day.meals, [
      { type: 'breakfast', title: 'Pancakes', note: 'with berries' },
      { type: 'dinner', title: 'Fish tacos', recipe: 'fish-tacos' },
    ]);
    equal(hits.at(-1).auth, 'Bearer mealie-token');
    equal(hits.at(-1).start, '2026-11-20');
    equal(day.unavailable, undefined);
  });

  it('older Mealie (meal plans per group) works too', async () => {
    mode = 'groups';
    const fresh = new (await import('../src/adapters/MealieAdapter.js')).MealieAdapter({ roster: null, config: (await import('../src/config.js')).default });
    const meals = await fresh.mealsFor('2026-11-20');
    equal(meals.length, 2);
    ok(hits.some((h) => h.path === '/api/groups/mealplans'));
    mode = 'households';
  });

  it('Mealie down: the day still comes back, saying Mealie is unavailable', async () => {
    mode = 'down';
    const day = await gw.getDay('2026-11-20');
    deepEqual(day.meals, []);
    ok(JSON.stringify(day.unavailable ?? day).includes('mealie'));
    mode = 'households';
  });
});
