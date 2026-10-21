import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteContentPolicy, withRemoteContentPolicy } from '../image-blocker.js';

test('the blocked policy names no remote scheme', () => {
  const policy = remoteContentPolicy(false);

  assert.match(policy, /^default-src 'none'; /);
  assert.doesNotMatch(policy, /https?:/);
});

test('showing images opens the design resources and nothing else', () => {
  const directives = Object.fromEntries(remoteContentPolicy(true).split('; ')
    .map((d) => [d.split(' ')[0], d]));

  for (const name of ['img-src', 'media-src', 'font-src', 'style-src']) {
    assert.match(directives[name], / http: https:$/, name);
  }
  // Frames, objects and connections fall back to this one.
  assert.equal(directives['default-src'], "default-src 'none'");
});

test('the policy leads the document, after a doctype if there is one', () => {
  const meta = /^<meta http-equiv="Content-Security-Policy" content="[^"]+">/;

  assert.match(withRemoteContentPolicy('<p>hi</p>'), meta);
  assert.match(withRemoteContentPolicy('<html><head></head><body></body></html>'), meta);
  assert.match(withRemoteContentPolicy(''), meta);

  const doctyped = withRemoteContentPolicy('\n<!DOCTYPE html><html><body></body></html>');
  assert.ok(doctyped.startsWith('\n<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'));
});
