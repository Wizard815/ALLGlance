// Base adapter interface. Every data-plane adapter implements this shape so
// the gateway can treat them uniformly: register tools, read tasks/calendar,
// and refresh the family roster. See DESIGN.md §4.

export class BaseAdapter {
  /** @type {string} 'vikunja' | 'dayglance' | 'lastglance' | 'lifeglance' */
  source = 'base';
  label = 'Unknown';
  enabled = false;

  /**
   * @param {object} opts
   * @param {import('./identity/roster.js').Roster} opts.roster
   * @param {import('./config.js').default} opts.config
   */
  constructor({ roster, config }) {
    this.roster = roster;
    this.config = config;
  }

  /** Health check — resolve true/false/undefined (undefined = "not tried yet"). */
  async status() {
    return undefined;
  }

  /** Read tasks for a date range, optionally scoped to an owner. */
  async readTasks() {
    return { tasks: [] };
  }

  /** Read the day's time blocks (dayGLANCE). */
  async readBlocks() {
    return { blocks: [] };
  }

  /** Read milestones (lifeGLANCE). */
  async readMilestones() {
    return { milestones: [] };
  }

  /** Read recent chores (lastGLANCE). */
  async readChores() {
    return { chores: [] };
  }

  /** Create/update a task. Adapters without a server surface return null. */
  async writeTask() {
    return null;
  }

  /** Register this adapter's MCP tools with the given MCP server instance. */
  registerTools(_server) {
    return [];
  }

  /** REST routes to mount under /api/allglance/<source>... */
  registerRoutes(_router) {
    return [];
  }
}

export default BaseAdapter;
