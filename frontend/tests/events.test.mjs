import assert from 'node:assert/strict';
import test from 'node:test';

// events.js connects itself at module evaluation in a browser. This flag is
// the seam that lets the tests drive it instead.
globalThis.window = {
  __LULL_EVENTS_TEST__: true,
  dispatchEvent() { return true; },
  addEventListener() {},
};
globalThis.__LULL_EVENTS_TEST__ = true;

const mod = await import('../events.js');

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, fn) { this.listeners.set(name, fn); }
  close() { this.closed = true; this.readyState = 2; }

  // ── test drivers ──
  open() { this.readyState = 1; this.onopen?.(); }
  frame(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  failHard() { this.readyState = 2; this.onerror?.(); }   // 404 / non-200
  dropConnection() { this.readyState = 0; this.onerror?.(); }
}

const fetches = [];

test.beforeEach(() => {
  FakeEventSource.instances = [];
  fetches.length = 0;
  globalThis.fetch = async (url) => {
    fetches.push(url);
    return { ok: true, json: async () => ({ running: false, polled: true }) };
  };
  mod._reset();
});

test.afterEach(() => {
  mod._reset();
});

test('a stream that cannot open at all falls back immediately', async () => {
  // readyState 2 means the browser gave up: a 404, a non-200, or the wrong
  // content type. It will never retry on its own, so waiting is silence.
  mod.connect(FakeEventSource);
  const es = FakeEventSource.instances[0];
  assert.equal(mod._internals.polling, false);

  es.failHard();

  assert.equal(mod._internals.polling, true, 'no fallback after a terminal error');
  assert.equal(mod._internals.grace, false, 'a terminal error must not wait');
  assert.equal(es.closed, true);
});

test('a dropped connection waits for the browser instead of polling on top', async () => {
  // readyState 0 means the browser is already retrying. Polling as well
  // would mean a healthy app paying for both channels forever.
  mod.connect(FakeEventSource);
  const es = FakeEventSource.instances[0];

  es.dropConnection();

  assert.equal(mod._internals.polling, false, 'polled while the browser was retrying');
  assert.equal(mod._internals.grace, true, 'nothing bounds how long the window stays blind');

  es.open();
  assert.equal(mod._internals.grace, false, 'reconnecting must cancel the fallback timer');
  assert.equal(mod._internals.polling, false);
});

test('the stream coming back stops the fallback exactly once', async () => {
  mod.connect(FakeEventSource);
  const es = FakeEventSource.instances[0];
  es.failHard();
  assert.equal(mod._internals.polling, true);

  const next = mod.connect(FakeEventSource);
  next.open();

  assert.equal(mod._internals.polling, false, 'the fallback outlived the stream');
});

test('a frame is broadcast as the event every view already listens for', async () => {
  const seen = [];
  globalThis.window.dispatchEvent = (e) => { seen.push([e.type, e.detail]); return true; };

  mod.connect(FakeEventSource);
  const es = FakeEventSource.instances[0];
  es.open();
  es.frame('hello', { run_id: 'abc', snapshot: { running: true } });
  es.frame('mail', { account: 'u@x.fr', count: 2, int_ids: [7, 8] });
  es.frame('verdict', { int_id: 7, category: 'newsletter' });

  assert.deepEqual(seen.map(([t]) => t), ['sync-status', 'lull:mail', 'lull:verdict']);
  assert.deepEqual(seen[0][1], { running: true });
  assert.equal(mod.lastStatus().running, true);
});

test('a reconnect tells the server which run it was following', async () => {
  mod.connect(FakeEventSource);
  const first = FakeEventSource.instances[0];
  assert.equal(first.url, '/api/events', 'the first connection knows no run');
  first.open();
  first.frame('hello', { run_id: 'run-1', snapshot: {} });

  mod.disconnect();
  mod.connect(FakeEventSource);
  const second = FakeEventSource.instances[1];
  assert.equal(second.url, '/api/events?run=run-1',
    'a reconnect that omits the run cannot be told a restart from a dropped socket');
});

test('no EventSource at all means the poll, not silence', async () => {
  mod.connect(undefined);
  assert.equal(mod._internals.polling, true);
});
