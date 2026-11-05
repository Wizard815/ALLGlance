// Compact, agent-friendly shapes for the MCP tools. The adapters keep the full
// source record in `extra` (useful over REST); an agent does not need it and it
// can be many times larger than the answer, so tools return only what is needed
// to read a result and to act on it (source + id go straight into update).

const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

export function compactTask(t) {
  return prune({
    source: t.source,
    id: t.id,
    title: t.title,
    done: Boolean(t.completed),
    due: t.due_date,
    start: t.start_time,
    duration_minutes: t.duration_minutes,
    all_day: t.all_day || null,
    priority: t.priority > 0 ? t.priority : null,
    priority_label: t.priority > 0 ? t.priority_label : null,
    owner: t.owner_id,
    project_id: t.project_id,
  });
}

export function compactBlock(b) {
  return prune({
    source: 'dayglance',
    id: b.id,
    title: b.title,
    type: b.type,
    start: b.start_time ?? b.startTime,
    duration_minutes: b.duration_minutes ?? b.duration,
    all_day: b.all_day || b.isAllDay || null,
    done: Boolean(b.completed),
    owner: b.owner_id,
  });
}

export function compactChore(c) {
  return prune({
    id: c.id,
    title: c.title,
    category: c.category,
    owner: c.owner_id,
    last_done: c.last_completed ? c.last_completed.slice(0, 10) : null,
    every_days: c.target_cadence_days,
    due: c.due_date,
    overdue: c.overdue,
  });
}

export function compactMilestone(m) {
  return prune({
    id: m.id,
    title: m.title,
    date: m.date,
    precision: m.date_precision,
    category: m.category,
    note: m.note ? String(m.note).slice(0, 200) : null,
  });
}

/** Soonest due first, undated last; higher priority first on ties. */
export const byDue = (a, b) => {
  if (!a.due_date !== !b.due_date) return a.due_date ? -1 : 1;
  if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  return (b.priority ?? 0) - (a.priority ?? 0) || String(a.title).localeCompare(String(b.title));
};

export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, server-local
