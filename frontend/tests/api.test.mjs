import assert from 'node:assert/strict';
import test from 'node:test';

// api.js reads the already-loaded browser i18n facade at module evaluation.
// The request layer itself has no DOM dependency, so this minimal browser
// global is enough to exercise it in Node without jsdom.
globalThis.window = { t: (key) => key };
const { api, requestJson } = await import('../api.js');

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('requestJson returns parsed JSON and detaches the caller abort listener', async () => {
  let added = 0;
  let removed = 0;
  const listeners = new Map();
  const externalSignal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, fn) {
      added += 1;
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
      removed += 1;
    },
  };
  globalThis.fetch = async (_url, { signal }) => {
    assert.equal(signal instanceof AbortSignal, true);
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await requestJson('/api/test', { signal: externalSignal });

  assert.deepEqual(result, { ok: true });
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(listeners.size, 0);
});

test('requestJson accepts an empty successful response', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await requestJson('/api/empty'), null);
});

test('requestJson normalises FastAPI errors and Retry-After', async () => {
  globalThis.fetch = async () => new Response('{"detail":{"message":"Patientez."}}', {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '7',
    },
  });

  await assert.rejects(
    requestJson('/api/limited'),
    (err) => err.message === 'Patientez.' && err.status === 429 && err.retryAfter === 7,
  );
});

test('requestJson distinguishes a timeout from caller cancellation', async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });

  await assert.rejects(
    requestJson('/api/slow', { timeoutMs: 5 }),
    (err) => err.status === 0 && err.timeout === true && err.cancelled === false,
  );

  const ctrl = new AbortController();
  const pending = requestJson('/api/cancelled', { signal: ctrl.signal, timeoutMs: 1000 });
  ctrl.abort('navigation');
  await assert.rejects(
    pending,
    (err) => err.status === 0 && err.cancelled === true && err.timeout === false,
  );
});

test('timeout remains active while the response body is streaming', async () => {
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }),
  });

  await assert.rejects(
    requestJson('/api/slow-body', { timeoutMs: 5 }),
    (err) => err.timeout === true && err.protocol !== true,
  );
});

test('requestJson surfaces a successful non-JSON body as a protocol error', async () => {
  globalThis.fetch = async () => new Response('<html>proxy error</html>', { status: 200 });

  await assert.rejects(
    requestJson('/api/bad-body'),
    (err) => err.status === 200 && err.protocol === true,
  );
});

test('API read methods forward cancellation signals', async () => {
  const ctrl = new AbortController();
  globalThis.fetch = async (url, { signal }) => {
    assert.equal(url, '/api/emails/42');
    assert.equal(signal.aborted, false);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      queueMicrotask(() => ctrl.abort('replaced'));
    });
  };

  await assert.rejects(
    api.getEmail(42, { signal: ctrl.signal }),
    (err) => err.cancelled === true,
  );
});
