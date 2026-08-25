import assert from 'node:assert/strict';
import test from 'node:test';

import { LatestRequest } from '../request-latest.js';

test('next aborts the superseded request and returns a fresh signal', () => {
  const latest = new LatestRequest();
  const first = latest.next();
  const second = latest.next();

  assert.equal(first.aborted, true);
  assert.equal(first.reason, 'superseded');
  assert.equal(second.aborted, false);
  assert.notEqual(first, second);
});

test('cancel aborts the current request and is idempotent', () => {
  const latest = new LatestRequest();
  const signal = latest.next();

  latest.cancel('unmounted');
  latest.cancel('ignored');

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, 'unmounted');
  assert.equal(latest.controller, null);
});
