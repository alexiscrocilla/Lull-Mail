// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  OP_SOURCE, dropOperator, freeText, isExpressible, quote, readOperator,
  setOperator, tokens,
} from '../search-query.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, '..', '..', 'src', 'search_query.py');

test('the grammar is the one the server parses, byte for byte', () => {
  // The whole point of keeping this module a splicer rather than a parser is
  // that the contract between the two sides is ONE regex. Read it out of the
  // Python source rather than restating it here, so a change on either side
  // has to be a deliberate change on both.
  const py = readFileSync(PY, 'utf8');
  const m = py.match(/_OP = re\.compile\(\s*r'([^']*)',/);
  assert.ok(m, 'could not find _OP in src/search_query.py');
  // The Python literal is a raw string; the JS one escapes its backslashes.
  assert.equal(OP_SOURCE.replace(/\\\\/g, '\\'), m[1]);
});

test('tokens finds every operator, quoted or not, with its span', () => {
  const q = 'facture from:nora@x.fr subject:"Re: devis" is:unread';
  const got = tokens(q).map((t) => [t.op, t.value, t.quoted]);
  assert.deepEqual(got, [
    ['from', 'nora@x.fr', false],
    ['subject', 'Re: devis', true],
    ['is', 'unread', false],
  ]);
  const first = tokens(q)[0];
  assert.equal(q.slice(first.start, first.end), 'from:nora@x.fr');
});

test('setOperator replaces in place and leaves everything else alone', () => {
  const q = 'facture from:nora@x.fr min_score:7 "devis signé"';
  const out = setOperator(q, 'from', 'louis@y.fr');
  assert.equal(out, 'facture from:louis@y.fr min_score:7 "devis signé"');
});

test('setOperator appends when the operator is absent', () => {
  assert.equal(setOperator('facture', 'subject', 'devis'), 'facture subject:devis');
  assert.equal(setOperator('', 'subject', 'devis'), 'subject:devis');
});

test('a value with a space is quoted on write', () => {
  assert.equal(setOperator('', 'from', 'Marie Dupont'), 'from:"Marie Dupont"');
  assert.equal(quote('nora@x.fr'), 'nora@x.fr');
});

test('the is: family is respected: starred does not overwrite unread', () => {
  const q = 'is:unread';
  const out = setOperator(q, 'is', 'starred', 'starred');
  assert.equal(out, 'is:unread is:starred');
  assert.equal(readOperator(out, 'is', 'read'), 'unread');
  assert.equal(readOperator(out, 'is', 'starred'), 'starred');
});

test('dropping one predicate leaves its siblings', () => {
  const q = 'facture is:unread is:starred has:attachment';
  const out = dropOperator(q, 'is', 'starred');
  assert.equal(out, 'facture is:unread has:attachment');
});

test('setOperator with an empty value removes the operator', () => {
  assert.equal(setOperator('facture from:nora@x.fr', 'from', ''), 'facture');
});

test('what the controls cannot express survives every splice', () => {
  // min_score, to:, a typed in:, a quoted phrase: none of them has a control,
  // and none of them may be destroyed by using one.
  const q = 'to:moi@x.fr min_score:7 in:sent "rapport annuel" from:a@x.fr';
  let out = setOperator(q, 'from', 'b@x.fr');
  out = setOperator(out, 'subject', 'devis');
  out = dropOperator(out, 'subject');
  assert.equal(out, 'to:moi@x.fr min_score:7 in:sent "rapport annuel" from:b@x.fr');
});

test('freeText is what is left once the operators are taken out', () => {
  assert.equal(freeText('facture from:nora@x.fr urgente is:unread'), 'facture urgente');
  assert.equal(freeText('from:nora@x.fr'), '');
});

test('a value carrying a quote is named as inexpressible, not mangled', () => {
  assert.equal(isExpressible('Marie Dupont'), true);
  assert.equal(isExpressible('say "hi"'), false);
});

test('dropping the only token leaves an empty string, not a stray space', () => {
  assert.equal(dropOperator('from:nora@x.fr', 'from'), '');
  assert.equal(dropOperator('a from:nora@x.fr b', 'from'), 'a b');
});
