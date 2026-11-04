// THE DESCRIPTION SECTION of a project or goal note (companion §4.3, owner
// ruling 2026-10-03). Pure.
//
// A project's notes box in dayGLANCE and the paragraph under its note's
// title are one thing: the text between the H1 and the first heading below
// it. The default template seeds that slot with a placeholder; the panel in
// dayGLANCE loads the section, edits it, and writes it back through a
// section-replace intent. This is an editor over the file, like the task
// panel's editor over a wikilinked note, not a sync: nothing is merged and
// nothing lives in the record once the note exists.
//
// REFUSE ON CHANGE. The save carries the section's hash as loaded (`base`).
// dayGLANCE re-reads before sending and reloads instead of saving when the
// section moved; the applier checks the same hash against the note at apply
// time and, on a mismatch, keeps the vault's section and APPENDS the
// dayGLANCE text as a dated callout rather than overwriting or dropping it.
// Both halves are here so the two sides cannot drift.

import { hasFrontmatter } from './frontmatter.js';
import { noteContainsBlock } from './bridgeStream.js';

/** What the default templates seed the slot with (projectNotes.js). */
export const DESCRIPTION_PLACEHOLDERS = Object.freeze([
  'One line on what done looks like.',
  'Why this matters, and what finished looks like.',
]);

const normalize = (text) => String(text ?? '').replace(/\r\n?/g, '\n');

/** FNV-1a over the normalized text, as eight hex digits. Cheap and stable across devices. */
export function noteTextHash(text) {
  let h = 0x811c9dc5;
  const s = normalize(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const HEADING = /^#{1,6}\s/;

/**
 * Split a note into the part before the description (frontmatter and the
 * H1, when present), the description itself (trimmed of surrounding blank
 * lines), and the rest from the next heading on.
 * @returns {{ head: string, section: string, tail: string }}
 */
export function splitNoteDescription(text) {
  const lines = normalize(text).split('\n');
  let i = 0;
  if (hasFrontmatter(lines.join('\n'))) {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    if (i < lines.length) i++; // past the closing fence
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s/.test(lines[i])) i++; // the H1
  const headEnd = i;
  let j = i;
  while (j < lines.length && !HEADING.test(lines[j])) j++;
  const sectionLines = lines.slice(headEnd, j);
  while (sectionLines.length && sectionLines[0].trim() === '') sectionLines.shift();
  while (sectionLines.length && sectionLines[sectionLines.length - 1].trim() === '') sectionLines.pop();
  return {
    head: lines.slice(0, headEnd).join('\n') + (headEnd > 0 ? '\n' : ''),
    section: sectionLines.join('\n'),
    tail: lines.slice(j).join('\n'),
  };
}

/** The description as the panel shows it ('' when none). */
export function extractNoteDescription(text) {
  return splitNoteDescription(text).section;
}

/** The note with its description replaced (removed when `content` is blank). */
export function replaceNoteDescription(text, content) {
  const { head, tail } = splitNoteDescription(text);
  const body = normalize(content).trim();
  const middle = body ? `${body}\n` : '';
  if (!tail) return `${head}${middle}`;
  return `${head}${middle}${middle ? '\n' : ''}${tail}`;
}

/**
 * The migration write: a blank or placeholder section is replaced; text the
 * user already has stays and the dayGLANCE text goes below it; a body already
 * present as whole blocks changes nothing.
 */
export function mergeNoteDescription(text, content) {
  const body = normalize(content).trim();
  if (!body) return { text: normalize(text), changed: false };
  const { section } = splitNoteDescription(text);
  if (!section || DESCRIPTION_PLACEHOLDERS.includes(section.trim())) {
    return { text: replaceNoteDescription(text, body), changed: true };
  }
  if (noteContainsBlock(section, body)) return { text: normalize(text), changed: false };
  return { text: replaceNoteDescription(text, `${section}\n\n${body}`), changed: true };
}

/**
 * The refuse-on-change outcome at the applier: the vault's section stays,
 * the dayGLANCE text is appended as a dated callout. Idempotent on the
 * callout body.
 */
export function appendDescriptionConflict(text, content, at) {
  const body = normalize(content).trim();
  const { section } = splitNoteDescription(text);
  if (!body || noteContainsBlock(section, body)) return { text: normalize(text), changed: false };
  const callout = [`> [!note] Edited in dayGLANCE ${String(at ?? '').trim()}`.trimEnd(), ...body.split('\n').map((l) => `> ${l}`)].join('\n');
  if (noteContainsBlock(section, callout)) return { text: normalize(text), changed: false };
  return { text: replaceNoteDescription(text, section ? `${section}\n\n${callout}` : callout), changed: true };
}
