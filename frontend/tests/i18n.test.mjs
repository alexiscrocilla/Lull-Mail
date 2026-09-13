import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The dictionary is the one place a rename can break a surface nobody was
// looking at: the shared confirm dialog lived under `cleanup.*` while the
// mailbox imported it, so a sweep of that namespace would have degraded every
// confirm button in the app to a raw key string. These tests make that class
// of mistake fail here instead of on screen.

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const SRC = readFileSync(join(FRONTEND, 'i18n.js'), 'utf8');

// Split the two dictionaries on the `en:` boundary and read the keys of each.
const EN_AT = SRC.indexOf('\n  en: {');
assert.ok(EN_AT > 0, 'could not find the en dictionary boundary');
const keysIn = (text) =>
  new Set([...text.matchAll(/^ {4}'([^']+)':/gm)].map((m) => m[1]));
const FR_KEYS = keysIn(SRC.slice(0, EN_AT));
const EN_KEYS = keysIn(SRC.slice(EN_AT));

test('every French key has an English twin and vice versa', () => {
  const onlyFr = [...FR_KEYS].filter((k) => !EN_KEYS.has(k));
  const onlyEn = [...EN_KEYS].filter((k) => !FR_KEYS.has(k));
  assert.deepEqual(onlyFr, [], 'keys missing from the English dictionary');
  assert.deepEqual(onlyEn, [], 'keys missing from the French dictionary');
  assert.ok(FR_KEYS.size > 500, `suspiciously few keys parsed (${FR_KEYS.size})`);
});

test('every key referenced by the app exists in both dictionaries', () => {
  // Only prefixes the dictionary actually owns, so a hostname like
  // "smtp.gmail.com" in a placeholder is never mistaken for a key.
  const PREFIXES = [
    'mb', 'set', 'cleanup', 'confirm', 'ob', 'cmdk', 'rail', 'report', 'diag',
    'shortcuts', 'update', 'cat', 'time', 'unsub', 'rt', 'aiw', 'provider',
  ];
  // The trailing (?!\s*\+) drops literals that are only the prefix of a key
  // built by concatenation, e.g. t('set.llm.role_' + role).
  const KEYISH = new RegExp(
    `'((?:${PREFIXES.join('|')})\\.[a-z0-9_.]+)'(?!\\s*\\+)`, 'gi',
  );
  const ATTR = /data-i18n(?:-html|-placeholder|-aria-label|-title)?="([^"]+)"/g;

  const files = [
    ...readdirSync(FRONTEND).filter((f) => f.endsWith('.js') && f !== 'i18n.js'),
    'index.html', 'onboarding.html',
  ];

  const missing = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(FRONTEND, file), 'utf8');
    } catch {
      continue; // optional file
    }
    const referenced = new Set();
    for (const m of text.matchAll(KEYISH)) referenced.add(m[1]);
    if (file.endsWith('.html')) {
      for (const m of text.matchAll(ATTR)) referenced.add(m[1]);
    }
    for (const key of referenced) {
      // `<key>_one` variants are resolved at runtime from the base key.
      if (key.endsWith('_one')) continue;
      if (!FR_KEYS.has(key)) missing.push(`${file}: ${key} (missing in FR)`);
      else if (!EN_KEYS.has(key)) missing.push(`${file}: ${key} (missing in EN)`);
    }
  }
  assert.deepEqual(missing, [], `keys referenced but not defined:\n${missing.join('\n')}`);
});

test('the shared confirm dialog does not depend on the cleanup namespace', () => {
  const confirmSrc = readFileSync(join(FRONTEND, 'confirm.js'), 'utf8');
  const cleanupKeys = [...confirmSrc.matchAll(/'(cleanup\.[a-z0-9_.]+)'/gi)];
  assert.deepEqual(
    cleanupKeys.map((m) => m[1]), [],
    'confirm.js is shared with the mailbox; it must not read cleanup.* keys',
  );
  for (const k of ['confirm.cancel', 'confirm.default_title', 'confirm.default_ok']) {
    assert.ok(FR_KEYS.has(k) && EN_KEYS.has(k), `${k} must exist in both dictionaries`);
  }
});

// ── the singular fallback, exercised through the real t() ────────────────────

// `navigator` and `location` are getter-only globals in modern Node, so a
// plain assignment throws.
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value, writable: true, configurable: true, enumerable: true,
  });
}

async function loadI18n(lang = 'fr') {
  const store = new Map();
  defineGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  defineGlobal('navigator', { language: lang === 'fr' ? 'fr-FR' : 'en-GB' });
  defineGlobal('location', { search: `?lang=${lang}`, hash: '', href: 'http://localhost/' });
  globalThis.document = {
    readyState: 'complete',
    documentElement: { setAttribute() {}, getAttribute: () => null, lang: '' },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.window = globalThis;
  globalThis.fetch = async () => new Response('{}');
  // Cache-bust so each locale gets a fresh evaluation.
  await import(`../i18n.js?lang=${lang}&t=${Math.random()}`);
  return globalThis.window.t;
}

test('t() picks the _one variant when n is 1, in both locales', async () => {
  // Live case: with a single unsubscribable sender the bulk button used to
  // read "Se désabonner des 1 newsletters".
  for (const [lang, one, many] of [
    ['fr', 'Se désabonner de cette newsletter', 'Se désabonner des 4 newsletters'],
    ['en', 'Unsubscribe from this newsletter', 'Unsubscribe from all 4 newsletters'],
  ]) {
    const tr = await loadI18n(lang);
    assert.equal(tr('cleanup.unsub.bulk_btn', { n: 1 }), one);
    assert.equal(tr('cleanup.unsub.bulk_btn', { n: 4 }), many);
  }
});

test('t() leaves keys without a _one variant alone and still interpolates', async () => {
  const tr = await loadI18n('fr');
  // No `_one` twin: the plural string is used verbatim, n substituted.
  assert.equal(tr('mb.score.title', { n: 1 }), 'Score 1/10');
  // Unknown key falls back to the key itself, not to `<key>_one`.
  assert.equal(tr('cleanup.does.not.exist', { n: 1 }), 'cleanup.does.not.exist');
});
