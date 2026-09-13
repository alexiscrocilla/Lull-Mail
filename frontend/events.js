// SPDX-License-Identifier: GPL-3.0-or-later
//
// One connection to the server, for the lifetime of the window.
//
// The app used to find out what had changed by asking, twenty-three times a
// minute, forever — and still took a median of fourteen seconds to show a
// message that had already been written to the database, because the only
// arrival signal was a three-second sample of a boolean that is true just
// while a fetch pass runs. Half of real passes are too short to be sampled.
//
// This module owns the stream and re-broadcasts every frame as a DOM event,
// so the views that already listen for `sync-status` keep working unchanged.
//
// It lives at module scope on purpose. A subscription owned by a view mount
// leaks one connection per navigation, and Chromium allows six per origin:
// at six leaked streams every other request from this page queues client
// side and never issues, while the server sits idle and healthy. Module
// scope makes that impossible rather than unlikely.

const STREAM_URL = '/api/events';

// How long to wait, while the browser is already retrying on its own, before
// deciding the stream is not coming back and polling instead. Chosen so an
// ordinary resume or a two-second server restart never trips it, and the
// worst-case blind window stays far under the fifty-seven seconds this work
// replaces.
const RECONNECT_GRACE_MS = 20_000;

// Fallback cadence: what the rail used to do unconditionally.
const POLL_MS = 3000;
// After this long with no stream, stop asking so often. Nothing is going to
// change until the app is restarted.
const POLL_BACKOFF_AFTER_MS = 5 * 60_000;
const POLL_SLOW_MS = 15_000;

let _es = null;
let _pollTimer = null;
let _graceTimer = null;
let _pollStartedAt = 0;
let _lastStatus = null;
let _runId = null;

function _emit(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (_) { /* a listener throwing must not kill the stream */ }
}

// The one payload every view already understands.
function _broadcastStatus(s) {
  if (!s) return;
  _lastStatus = s;
  _emit('sync-status', s);
}

export function lastStatus() {
  return _lastStatus;
}

// A view that mounts after the stream opened has missed every frame so far,
// and on an idle mailbox there is no second one. This re-broadcasts what the
// stream already said, and asks once if it has said nothing yet.
export function refresh() {
  if (_lastStatus) {
    _emit('sync-status', _lastStatus);
    return;
  }
  // No frame yet. If a stream is open or opening, `hello` is on its way and
  // is always the first frame — asking over HTTP as well would just be the
  // poll this replaces, one request earlier.
  if (_es && _es.readyState !== 2) return;
  pollStatus();
}

// ── the fallback ────────────────────────────────────────────────────────────
// This is the body the rail used to run on a 3 s interval, moved here. It is
// the only lever a client has when the stream cannot open, which is why
// /api/sync/status is kept even though nothing polls it at rest.

async function pollStatus() {
  try {
    const r = await fetch('/api/sync/status');
    if (!r.ok) return;
    _broadcastStatus(await r.json());
  } catch (_) {
    // Backend down or restarting — leave the previous state alone.
  }
}

function startPolling() {
  if (_pollTimer) return;
  _pollStartedAt = Date.now();
  pollStatus();
  _pollTimer = setInterval(() => {
    pollStatus();
    if (Date.now() - _pollStartedAt > POLL_BACKOFF_AFTER_MS && _pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = setInterval(pollStatus, POLL_SLOW_MS);
    }
  }, POLL_MS);
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function clearGrace() {
  if (_graceTimer) {
    clearTimeout(_graceTimer);
    _graceTimer = null;
  }
}

// ── the stream ──────────────────────────────────────────────────────────────

function handle(event, data) {
  switch (event) {
    case 'hello':
    case 'resync':
      if (data && data.run_id) _runId = data.run_id;
      if (data && data.snapshot) _broadcastStatus(data.snapshot);
      if (event === 'resync') _emit('lull:resync', data || {});
      break;
    case 'sync':
      _broadcastStatus(data);
      break;
    case 'mail':
      _emit('lull:mail', data || {});
      break;
    case 'body':
      _emit('lull:body', data || {});
      break;
    case 'verdict':
      _emit('lull:verdict', data || {});
      break;
    default:
      break;
  }
}

export function connect(EventSourceImpl = globalThis.EventSource) {
  if (!EventSourceImpl) {
    // No EventSource at all (a very old shell, or a test without one).
    startPolling();
    return null;
  }
  if (_es) return _es;

  // The run id lets the server tell a reconnect after a restart from one
  // that merely lost the socket. The browser resends Last-Event-ID on its
  // own; it cannot be told to send anything else.
  const url = _runId ? `${STREAM_URL}?run=${encodeURIComponent(_runId)}` : STREAM_URL;
  const es = new EventSourceImpl(url);
  _es = es;

  for (const name of ['hello', 'resync', 'sync', 'mail', 'body', 'verdict']) {
    es.addEventListener(name, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch (_) { /* keepalive or junk */ }
      handle(name, data);
    });
  }

  es.onopen = () => {
    clearGrace();
    stopPolling();
  };

  es.onerror = () => {
    // Two states, and conflating them is the difference between polling
    // forever on a perfectly healthy app and going silent against a server
    // that does not have this route.
    if (es.readyState === 2 /* CLOSED */) {
      // 404, a non-200, or the wrong content type. The browser will never
      // retry this. Decide immediately.
      clearGrace();
      _es = null;
      try { es.close(); } catch (_) {}
      startPolling();
      return;
    }
    // CONNECTING: the browser is already retrying, roughly every few
    // seconds, forever. Do not poll on top of that — just put a floor under
    // how long the window can stay blind.
    if (!_graceTimer && !_pollTimer) {
      _graceTimer = setTimeout(() => {
        _graceTimer = null;
        startPolling();
      }, RECONNECT_GRACE_MS);
    }
  };

  return es;
}

export function disconnect() {
  clearGrace();
  stopPolling();
  if (_es) {
    try { _es.close(); } catch (_) {}
    _es = null;
  }
}

// Test seam: the module keeps process-wide state on purpose, so tests need a
// way back to zero.
export function _reset() {
  disconnect();
  _lastStatus = null;
  _runId = null;
  _pollStartedAt = 0;
}

export const _internals = {
  get polling() { return _pollTimer !== null; },
  get grace() { return _graceTimer !== null; },
  get stream() { return _es; },
};

if (typeof window !== 'undefined' && !window.__LULL_EVENTS_TEST__) {
  window.lullEvents = { connect, disconnect, lastStatus, refresh };
  connect();
}
