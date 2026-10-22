// Focused tests for the two runtime bugs observed against the live gateway:
//   1. DayglanceAdapter has NO status() -> gateway.health() silently omits it.
//   2. The Playwright localStorage fallback is never wired to the dayglance
//      adapter, so dayglance reads always come back empty in the Docker build.
import { ok, equal } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Roster } from '../src/identity/roster.js';
import { DayglanceAdapter } from '../src/adapters/DayglanceAdapter.js';

const fakeConfig = {
  dayglance: { enabled: true },
  playwright: { headless: true, timeoutMs: 100 },
};

// A transport that mimics what server.js would inject — but the bug is that
// server.js never injects it for dayglance in the Docker/web deployment.
const fakeTransport = {
  read() {
    return {
      tasks: [
        { id: 'a', title: 'Walk the dog', date: '2026-09-30', startTime: '08:00', duration: 30, isAllDay: false, completed: false, assignedUserSyncIds: ['dad'] },
        { id: 'b', title: 'Team standup', date: '2026-09-30', startTime: '09:30', duration: 15, isAllDay: false, completed: true, assignedUserSyncIds: ['me'] },
      ],
      blocks: [
        { id: 'a', title: 'Walk the dog', date: '2026-09-30' },
        { id: 'b', title: 'Team standup', date: '2026-09-30' },
      ],
      users: [{ syncId: 'dad', name: 'Dad' }, { syncId: 'me', name: 'Me' }],
      meUserSyncId: 'me',
    };
  },
};

describe('dayglance adapter', () => {
  it('BUG 1: exposes status() so gateway health() includes it', async () => {
    const adapter = new DayglanceAdapter({ roster: new Roster(), config: fakeConfig });
    const s = await adapter.status();
    ok(s, 'status() should return a truthy health object, not undefined');
  });

  it('BUG 2: a wired Playwright/transport reader actually returns tasks + blocks', async () => {
    const adapter = new DayglanceAdapter({ roster: new Roster(), config: fakeConfig });
    adapter.setTransport(fakeTransport);
    const { tasks } = await adapter.readTasks();
    equal(tasks.length, 2, 'readTasks() should return the transport tasks');
    equal(tasks[0].title, 'Walk the dog');
    equal(tasks[0].owner_id, 'dad');
    equal(tasks[0].completed, false);

    const { blocks } = await adapter.readBlocks('2026-09-30');
    equal(blocks.length, 2, 'readBlocks() should return the transport blocks');

    // Roster should be synced from the transport state on read.
    const names = (await adapter.refreshRoster()).map((p) => p.name);
    ok(names.includes('Dad'), 'roster should include the transport users');
  });

  it('BUG 3: no transport injected — falls back to localStorage parser', async () => {
    // Simulates the Docker/web deployment where the desktop MCP isn't
    // reachable, so server.js installs the Playwright fallback transport
    // built on the adapter's own #reader.
    const fakeReader = {
      read: async () => ({
        'day-planner-tasks': JSON.stringify([
          { id: 'x', title: 'Groceries', date: '2026-09-30', startTime: '17:00', duration: 45, isAllDay: false, completed: false, assignedUserSyncIds: ['me'] },
        ]),
        'day-planner-unscheduled': JSON.stringify([]),
        'dayglance-users': JSON.stringify([
          { syncId: 'me', name: 'Me' },
          { syncId: 'dad', name: 'Dad' },
        ]),
        'dayglance-multi-user-config': JSON.stringify({ meUserSyncId: 'me', users: [{ syncId: 'me' }] }),
      }),
    };
    const adapter = new DayglanceAdapter({
      roster: new Roster(),
      config: fakeConfig,
      reader: fakeReader,
    });
    const { tasks } = await adapter.readTasks();
    equal(tasks.length, 1, 'localStorage fallback should parse the task arrays');
    equal(tasks[0].title, 'Groceries');
    equal(tasks[0].owner_id, 'me');
    const roster = await adapter.refreshRoster();
    ok(roster.map((p) => p.name).includes('Dad'), 'roster should sync from localStorage users');
  });
});
