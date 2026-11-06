// allglance_get_day with the dayGLANCE adapter switched off (ENABLE_DAYGLANCE=false, the Omi-only
// stack): Gateway.readBlocks must return a list, not { blocks }. The live Omi week run hit
// "blocks.map is not a function" here because every other getDay test stubs readBlocks.
// Its own file: the env switch has to be set before src/config.js is imported.
import { describe, it } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';

process.env.ENABLE_DAYGLANCE = 'false';
process.env.ENABLE_LASTGLANCE = 'false';
process.env.ENABLE_LIFELANCE = 'false';
process.env.ENABLE_OMI = 'false';
const { Gateway } = await import('../src/gateway.js');

describe('allglance_get_day without dayGLANCE', () => {
  it('returns an empty block list and no unavailable note', async () => {
    const gw = new Gateway();
    equal(gw.has('dayglance'), false, 'the switch is honoured');
    gw.readTasksDetailed = async () => ({ by: { vikunja: [], dayglance: [] }, unavailable: [] });
    deepEqual(await gw.readBlocks('2026-10-27'), []);
    const day = await gw.getDay('2026-10-27');
    deepEqual(day.blocks, []);
    equal(day.unavailable, undefined, 'no adapter is not an unavailable adapter');
  });

  it('lists chores and milestones as empty lists when those apps are off', async () => {
    const gw = new Gateway();
    deepEqual(await gw.readChores(), []);
    deepEqual(await gw.readMilestones(), []);
    equal((await gw.listChores()).total, 0);
    equal((await gw.listMilestones()).total, 0);
  });
});
