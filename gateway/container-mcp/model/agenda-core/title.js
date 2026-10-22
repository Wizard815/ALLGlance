// Title segmenting for display (companion spec 4.2). Pure.
//
// A task title carries two kinds of markup dayGLANCE's own cards render
// specially: `#tags` (the app's extractTags alphabet: a letter, then
// letters/digits/_/-//) and `[[wikilinks]]` (with an optional `|alias`).
// The sidebar renders tags faded and wikilinks as their display text with
// a click-through to the note, so it needs the title as segments rather
// than a string. Nothing here decides what a tag or link MEANS.
//
// A web address is matched first and kept as text, so a tag-shaped fragment
// inside one (…/guide#setup) is not a tag, as in the app's extractTags.

const TOKEN = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|#(\p{L}[\p{L}\p{N}_/-]*)/gu;

/**
 * @param {string} title
 * @returns {Array<{ type: 'text', text: string } | { type: 'tag', text: string, tag: string } | { type: 'link', text: string, target: string }>}
 *   `text` is always what to display; `tag` is the bare tag (lowercased, the
 *   app's key form); `target` is the note name a wikilink points at.
 */
export function splitTitle(title) {
  const s = String(title ?? '');
  const out = [];
  let last = 0;
  // Adjacent text (a run, then an address kept as text) reads as one segment.
  const text = (value) => {
    const prev = out[out.length - 1];
    if (prev?.type === 'text') prev.text += value;
    else out.push({ type: 'text', text: value });
  };
  for (const m of s.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) text(s.slice(last, at));
    if (m[1] !== undefined) {
      text(m[1]);
    } else if (m[2] !== undefined) {
      const target = m[2].trim();
      out.push({ type: 'link', text: (m[3] ?? target).trim() || target, target });
    } else {
      out.push({ type: 'tag', text: m[0], tag: m[4].toLowerCase() });
    }
    last = at + m[0].length;
  }
  if (last < s.length) text(s.slice(last));
  return out;
}
