import assert from 'node:assert/strict';
import test from 'node:test';

// The day arithmetic is local time; pin it to the zone the app is tested in,
// which also puts both clock changes of 2026 within reach.
process.env.TZ = 'Europe/Paris';
globalThis.window = { t: (key) => key };
const { msUntilLocalMidnight, refreshShortDates, shortDate, shortDateHtml } = await import('../api.js');

const MAIL = '2026-08-25T09:30:00+00:00'; // 11:30 in Paris

test('shortDate names the day relative to the one it is given', () => {
  assert.equal(shortDate(MAIL, new Date('2026-08-25T23:59:00+02:00')), "Aujourd'hui 11:30");
  assert.equal(shortDate(MAIL, new Date('2026-08-26T00:00:00+02:00')), 'Hier 11:30');
  assert.equal(shortDate(MAIL, new Date('2026-08-27T00:00:00+02:00')), '25 août');
  assert.equal(shortDate(MAIL, new Date('2027-01-01T00:00:00+01:00')), '25 août 2026');
});

test('shortDate leaves a missing or unreadable date empty, whatever the day', () => {
  assert.equal(shortDate('', new Date()), '');
  assert.equal(shortDate(null), '');
  assert.equal(shortDate('not a date'), '');
});

test('the next local midnight is a calendar day away, not 24 hours', () => {
  assert.equal(msUntilLocalMidnight(new Date('2026-08-25T23:59:00+02:00')), 60_000);
  // 29 March loses an hour, 25 October gains one.
  assert.equal(msUntilLocalMidnight(new Date('2026-03-29T00:00:00+01:00')), 23 * 3_600_000);
  assert.equal(msUntilLocalMidnight(new Date('2026-10-25T00:00:00+02:00')), 25 * 3_600_000);
});

test('shortDateHtml keeps the timestamp it formatted, escaped', () => {
  const html = shortDateHtml(MAIL, 'mb-date');
  assert.match(html, /^<span class="mb-date" data-short-date="2026-08-25T09:30:00\+00:00">/);
  assert.match(shortDateHtml('"><b>'), /data-short-date="&quot;&gt;&lt;b&gt;"/);
  assert.match(shortDateHtml(MAIL), /^<span data-short-date=/);
});

// Just enough of the DOM for refreshShortDates: elements that carry a
// timestamp, and the card that repeats it in its accessible name.
function named(label) {
  const attrs = { 'aria-label': label };
  return {
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
  };
}

function dateLabel(iso, text, owner = null) {
  return {
    textContent: text,
    getAttribute: (name) => (name === 'data-short-date' ? iso : null),
    closest: (selector) => (selector === '[data-short-date-label]' ? owner : null),
  };
}

function rootOf(...elements) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, '[data-short-date]');
      return elements;
    },
  };
}

test('refreshShortDates re-formats each label for the day it is given', () => {
  const card = named("Camille. Revu Aujourd'hui 11:30. Aujourd'hui 11:30. Non lu");
  const inCard = dateLabel(MAIL, "Aujourd'hui 11:30", card);
  const loose = dateLabel('2026-08-24T09:30:00+00:00', 'Hier 11:30');

  refreshShortDates(rootOf(inCard, loose), new Date('2026-08-26T00:00:00+02:00'));

  assert.equal(inCard.textContent, 'Hier 11:30');
  assert.equal(loose.textContent, '24 août');
  // The subject may spell the old label; only the date part of the name moves.
  assert.equal(card.getAttribute('aria-label'), "Camille. Revu Aujourd'hui 11:30. Hier 11:30. Non lu");
});

test('refreshShortDates leaves a label that is still right alone', () => {
  let writes = 0;
  const label = dateLabel(MAIL, "Aujourd'hui 11:30");
  const tracked = {
    ...label,
    get textContent() { return "Aujourd'hui 11:30"; },
    set textContent(_) { writes += 1; },
  };
  refreshShortDates(rootOf(tracked), new Date('2026-08-25T18:00:00+02:00'));
  assert.equal(writes, 0);
});
