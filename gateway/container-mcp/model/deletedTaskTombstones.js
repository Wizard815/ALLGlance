// The user-intent deletion tombstone (deletedTaskIds), shared by the UI's
// delete and the MCP undo of a created recurring series (#2066), so both write
// exactly the same record.
//
// PROVENANCE (see utils/retiredTaskIds.js): a caller here KNOWS INTENT — the
// task or series was removed and there is no successor — so it writes
// deletedTaskIds, never retiredTaskIds (that channel belongs to the commit-
// that-renames, which knows a successor) and never deletedObsidianKeys (the
// vault-scan detector's observed-vanish channel). Without the tombstone, cloud
// sync re-adds the removed row from a device that still has it.

export const DELETED_TASK_IDS_KEY = 'day-planner-deleted-task-ids';

export function recordDeletedTaskTombstone(taskId, nowIso = new Date().toISOString()) {
  try {
    const tombstones = JSON.parse(localStorage.getItem(DELETED_TASK_IDS_KEY) || '{}');
    tombstones[String(taskId)] = nowIso;
    localStorage.setItem(DELETED_TASK_IDS_KEY, JSON.stringify(tombstones));
  } catch { /* storage unavailable: the in-memory removal still stands */ }
}
