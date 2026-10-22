// Regression tests for two bugs ESLint surfaced when lint was first wired into CI:
//   1. taskOf() ignored `finished`: `status === 'closed' ?? finished` never reaches
//      `finished`, because a comparison is never null.
//   2. VikunjaAdapter.writeTask() called the #vikunjaUserId Map as a function, so
//      creating a task with an owner_id threw a TypeError.
import { equal, ok } from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { taskOf } from '../src/model.js';
import { VikunjaAdapter } from '../src/adapters/VikunjaAdapter.js';
import { Roster } from '../src/identity/roster.js';

describe('taskOf completion', () => {
  it('treats finished: true as completed', () => {
    equal(taskOf('x', { id: 1, finished: true }).completed, true);
  });
  it('still reads completed, done and a closed status', () => {
    equal(taskOf('x', { id: 1, completed: false, finished: true }).completed, false);
    equal(taskOf('x', { id: 1, done: true }).completed, true);
    equal(taskOf('x', { id: 1, status: 'closed' }).completed, true);
    equal(taskOf('x', { id: 1 }).completed, false);
  });
});

describe('VikunjaAdapter.writeTask', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('creates a task with an owner_id instead of throwing', async () => {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: { id: 7, title: 'Buy milk', due: null } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new VikunjaAdapter({
      config: { vikunja: { enabled: true, url: 'http://vikunja.test/', token: 't' } },
      roster: new Roster(),
    });
    const task = await adapter.writeTask({ title: 'Buy milk', owner_id: 'dad', project_id: 3 });
    ok(task, 'a task comes back');
    equal(task.title, 'Buy milk');
    equal(sent.url, 'http://vikunja.test/api/v2/tasks');
    equal(sent.body.title, 'Buy milk');
    equal(sent.body.assigned_user_ids, undefined); // no vikunja user mapped for "dad" yet
  });
});
