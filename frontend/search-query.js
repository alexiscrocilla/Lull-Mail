// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tokenise and splice the search field's operators. Deliberately NOT a
// parser: the meaning of every value -- which category names are valid,
// which date formats are accepted, what `is:` maps to, the 1-10 score range
// -- stays in src/search_query.py, server-side, where the AI agent's
// search_emails tool reads it too.
//
// What lives here is only what a click needs in order to edit the string the
// user can see: where each operator sits, and how to put one in or take one
// out without disturbing anything around it. That keeps the contract between
// the two sides down to a single regex, which tests/search-query.test.mjs
// asserts is byte-identical to the one in search_query.py.

// operator:value  OR  operator:"quoted value"
// Byte-identical to _OP in src/search_query.py. Do not "improve" one side.
export const OP_SOURCE =
  '\\b(from|to|subject|in|is|has|category|min_score|label|before|after):(?:"([^"]*)"|(\\S+))';

const opRe = () => new RegExp(OP_SOURCE, 'gi');

// Three predicates share the `is:` key, so an operator alone does not
// identify a control. A family says which of them a control owns:
// setOperator(s, 'is', 'starred', 'starred') must not touch `is:unread`.
const FAMILIES = {
  read: new Set(['read', 'unread']),
  starred: new Set(['starred', 'unstarred']),
  reply: new Set(['needs_reply', 'reply']),
};

/** Every operator token in `text`, in order, with its exact span. */
export function tokens(text) {
  const out = [];
  const re = opRe();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const quoted = m[2] !== undefined;
    out.push({
      op: m[1].toLowerCase(),
      value: quoted ? m[2] : m[3],
      quoted,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

function matches(token, op, family) {
  if (token.op !== op) return false;
  if (!family) return true;
  const members = FAMILIES[family];
  return !!members && members.has(String(token.value || '').toLowerCase());
}

/** `"a b"` when the value needs it, `a` otherwise. */
export function quote(value) {
  const v = String(value == null ? '' : value);
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

/** True when the value cannot survive a round-trip through the grammar. */
export function isExpressible(value) {
  // `"([^"]*)"` has no escape, so a value containing a quote cannot be
  // written back. The caller strips it rather than silently mangling it.
  return !String(value == null ? '' : value).includes('"');
}

function splice(text, start, end, replacement) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  let out = before + replacement + after;
  // One space where the removal left two, and no leading/trailing space.
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}

/**
 * Put `op:value` into `text`, replacing the token already there if any.
 *
 * Everything else in the string is preserved byte for byte: free text,
 * unknown tokens, quoting the user typed themselves, and the operators the
 * panel has no control for.
 */
export function setOperator(text, op, value, family) {
  const src = String(text || '');
  const v = String(value == null ? '' : value);
  if (!v) return dropOperator(src, op, family);
  const token = tokens(src).find((tk) => matches(tk, op, family));
  const written = `${op}:${quote(v)}`;
  if (!token) return (src ? `${src.trimEnd()} ` : '') + written;
  return splice(src, token.start, token.end, written);
}

/** Remove the token for `op` (within `family`, if given). */
export function dropOperator(text, op, family) {
  const src = String(text || '');
  const token = tokens(src).find((tk) => matches(tk, op, family));
  if (!token) return src.trim();
  return splice(src, token.start, token.end, '');
}

/** The value currently written for `op`, or '' when there is none. */
export function readOperator(text, op, family) {
  const token = tokens(text).find((tk) => matches(tk, op, family));
  return token ? String(token.value || '') : '';
}

/** The free text left once every operator token is taken out. */
export function freeText(text) {
  const src = String(text || '');
  let out = '';
  let cursor = 0;
  for (const tk of tokens(src)) {
    out += src.slice(cursor, tk.start);
    cursor = tk.end;
  }
  out += src.slice(cursor);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
