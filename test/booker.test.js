import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock, seedTokens } from './env.js';

const { Booker } = await import('../src/booker.js');
const { EventsClient } = await import('../src/api.js');
const { DEFAULT_SETTINGS } = await import('../src/store.js');
const { normalize } = await import('../web/shared.js');
const { makeSessions } = await import('../mock/mock-events.js');

const T0 = Date.parse('2026-10-06T15:00:00Z');
const mk = (id, date, time, len = 60) => normalize({ ...makeSessions(1)[0], sessionId: id, abbreviation: id.toUpperCase(), title: `Title ${id}`, sessionTime: { date, time, length: String(len) } });
// A 09:00-10:00, B 09:30-10:30 (overlaps A), C 13:00, D 15:00, E 15:00 (overlaps D), F 17:00
const SESS = [mk('a', '2026-12-01', '09:00'), mk('b', '2026-12-01', '09:30'), mk('c', '2026-12-01', '13:00'), mk('d', '2026-12-01', '15:00'), mk('e', '2026-12-01', '15:00'), mk('f', '2026-12-01', '17:00')];
const catalog = { sessions: SESS };

function harness({ plan, waves = [], hook, persist } = {}) {
  let clock = T0, sleeps = 0;
  const sent = [];
  const sleep = async ms => { clock += ms; sleeps++; mock.ctl.quotaWindow = 0; await hook?.({ clock, sleeps }); };
  const booker = new Booker({
    client: new EventsClient({ sleepFn: sleep }),
    getPlan: () => ({ items: plan }), getCatalog: () => catalog,
    getSettings: () => ({ ...DEFAULT_SETTINGS, waves: waves.map(w => new Date(w).toISOString()) }),
    notify: async (subject) => { sent.push(subject); return { ok: true }; },
    now: () => clock, sleep, persist,
  });
  return { booker, sent, get sleeps() { return sleeps; }, get clock() { return clock; } };
}
const item = (id, tier) => ({ sessionId: id, tier });
async function finish(b) {
  for (let i = 0; i < 400; i++) { if (['done', 'error', 'stopped'].includes(b.state.status)) return b.state; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('run did not finish: ' + b.state.status);
}

beforeEach(async () => {
  seedTokens();
  mock.ctl.sessions = SESS.map(s => ({ ...s }));
  Object.assign(mock.ctl, { open: true, reserved: new Set(), favorites: new Set(), capacity: {}, writes: 0, reserveCalls: [], failNext: null, quotaPerMinute: 30, quotaUsed: 0 });
});

test('waits while reservations are closed (409), then books the plan when they open', async () => {
  mock.ctl.open = false;
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have')], hook: ({ sleeps }) => { if (sleeps === 4) mock.ctl.open = true; } });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.equal(st.status, 'done');
  assert.deepEqual([...mock.ctl.reserved].sort(), ['a', 'c']);
  assert.ok(h.sleeps >= 4, 'it must have waited');
  assert.ok(h.sent.some(s => /just opened/.test(s)), 'sends an "opened" email');
  assert.ok(h.sent.some(s => /2 booked/.test(s)), 'sends a report email');
});

test('a full must-have is replaced by the backup in the same slot', async () => {
  mock.ctl.capacity = { a: 0 };
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have'), item('b', 'Backup')] });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved].sort(), ['b', 'c']);
  const a = st.rows.find(r => r.sessionId === 'a'), b = st.rows.find(r => r.sessionId === 'b');
  assert.equal(a.kind, 'full'); assert.equal(b.kind, 'backup');
});

test('a backup is never booked when its must-have succeeds', async () => {
  const h = harness({ plan: [item('a', 'Must-have'), item('b', 'Backup')] });
  await h.booker.start({ mode: 'live' });
  await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved], ['a']);
});

test('two plan items in the same slot are never sent in one request', async () => {
  const h = harness({ plan: [item('d', 'Must-have'), item('e', 'Nice-to-have')] });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved], ['d']);
  assert.equal(st.rows.find(r => r.sessionId === 'e').kind, 'other'); // skipped: overlaps a session already held
  assert.ok(mock.ctl.reserveCalls.every(call => !(call.includes('d') && call.includes('e'))));
});

test('a session full in wave 1 is retried at wave 2 when seats appear', async () => {
  mock.ctl.capacity = { c: 0 };
  const wave2 = T0 + 60 * 60_000;
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have')], waves: [wave2], hook: ({ clock }) => { if (clock >= wave2 - 60_000) mock.ctl.capacity = {}; } });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved].sort(), ['a', 'c']);
  assert.equal(st.status, 'done');
  assert.ok(h.sent.some(s => /wave 1/i.test(s)));
});

test('a timeout after the server applied the request does not double-book', async () => {
  mock.ctl.failNext = 'apply-then-503';
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have')] });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved].sort(), ['a', 'c']);
  assert.equal(mock.ctl.reserveCalls.length, 1, 'it must read the schedule, not re-send');
  assert.ok(st.rows.every(r => r.kind === 'reserved'));
});

test('a 5xx where nothing was applied is retried once the schedule shows it is missing', async () => {
  mock.ctl.failNext = '503';
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have')] });
  await h.booker.start({ mode: 'live' });
  await finish(h.booker);
  assert.deepEqual([...mock.ctl.reserved].sort(), ['a', 'c']);
});

test('hitting the rate limit shrinks the request instead of waiting out the minute', async () => {
  mock.ctl.quotaPerMinute = 3;
  const plan = [item('a', 'Must-have'), item('c', 'Must-have'), item('d', 'Must-have'), item('f', 'Must-have')];
  const h = harness({ plan });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.equal(st.status, 'done');
  assert.deepEqual([...mock.ctl.reserved].sort(), ['a', 'c', 'd', 'f']);
});

test('rehearse sends no write requests at all', async () => {
  mock.ctl.open = false; // even closed, rehearse must not touch it
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have'), item('b', 'Backup')] });
  await h.booker.start({ mode: 'rehearse' });
  const st = await finish(h.booker);
  assert.equal(st.status, 'done');
  assert.equal(mock.ctl.writes, 0);
  assert.equal(mock.ctl.reserved.size, 0);
  assert.equal(st.rows.length, 2);
  assert.ok(h.sent.some(s => /booked/.test(s)));
});

test('an already-reserved session is left alone and counted', async () => {
  mock.ctl.reserved.add('a');
  const h = harness({ plan: [item('a', 'Must-have'), item('c', 'Must-have')] });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.equal(st.rows.find(r => r.sessionId === 'a').status, 'Already reserved');
  assert.deepEqual(mock.ctl.reserveCalls, [['c']]);
});

test('stopping while reservations are still closed ends the wait', async () => {
  mock.ctl.open = false;
  const h = harness({ plan: [item('a', 'Must-have')] });
  await h.booker.start({ mode: 'live' });
  await new Promise(r => setTimeout(r, 30));
  h.booker.stop();
  const st = await finish(h.booker);
  assert.equal(st.status, 'stopped');
  assert.equal(mock.ctl.reserved.size, 0);
});

test('an empty plan is refused with a clear message', async () => {
  const h = harness({ plan: [] });
  await h.booker.start({ mode: 'live' });
  const st = await finish(h.booker);
  assert.equal(st.status, 'error');
  assert.match(st.error, /Add at least one/);
});

test('swap: cancels the backup and reserves the original, restoring the backup on failure', async () => {
  mock.ctl.reserved.add('b');
  const h = harness({ plan: [item('a', 'Must-have'), item('b', 'Backup')] });
  await h.booker.swap('a');
  assert.deepEqual([...mock.ctl.reserved], ['a']);
  // original full again: should refuse and keep the backup
  mock.ctl.reserved = new Set(['b']); mock.ctl.capacity = { a: 0 };
  await assert.rejects(h.booker.swap('a'), /still shows as full/);
  assert.deepEqual([...mock.ctl.reserved], ['b']);
});


const liveSaved = (over = {}) => ({ savedAt: T0 - 60_000, state: { status: "booking", mode: "live", log: [{ t: T0 - 1, level: "", msg: "before the crash" }], rows: [], startedAt: T0 - 120_000, error: null, ...over } });

test("a live watch cut off by a crash is resumed, keeps its log, and does not double-book", async () => {
  mock.ctl.reserved.add("a"); // reserved before the app died
  const h = harness({ plan: [item("a", "Must-have"), item("c", "Must-have")] });
  assert.equal(h.booker.restore(liveSaved()).resume, true);
  await h.booker.start({ mode: "live", resumed: true });
  const st = await finish(h.booker);
  assert.equal(st.status, "done");
  assert.deepEqual([...mock.ctl.reserved].sort(), ["a", "c"]);
  assert.deepEqual(mock.ctl.reserveCalls, [["c"]], "only the missing session is sent");
  assert.equal(st.log[0].msg, "before the crash");
  assert.ok(st.log.some(l => /Resuming/.test(l.msg)));
});

test("a watch the user stopped, or that already finished, is shown but never resumed", async () => {
  for (const status of ["stopped", "done", "error", "idle"]) {
    const h = harness({ plan: [item("a", "Must-have")] });
    assert.equal(h.booker.restore(liveSaved({ status })).resume, false, status);
    assert.equal(h.booker.state.status, status);
  }
});

test("a rehearsal that was cut off is not resumed, and an old watch is not resumed on its own", async () => {
  const h = harness({ plan: [item("a", "Must-have")] });
  assert.equal(h.booker.restore(liveSaved({ mode: "rehearse" })).resume, false);
  assert.equal(h.booker.state.status, "stopped");
  const h2 = harness({ plan: [item("a", "Must-have")] });
  const old = liveSaved(); old.savedAt = T0 - 6 * 864e5;
  assert.equal(h2.booker.restore(old).resume, false);
  assert.match(h2.booker.state.log.at(-1).msg, /too old/);
});

test("run state is saved as it changes, so a restart can find it", async () => {
  const saves = [];
  const h = harness({ plan: [item("a", "Must-have")], persist: s => saves.push(s) });
  await h.booker.start({ mode: "live" });
  await finish(h.booker);
  assert.ok(saves.length >= 2);
  assert.equal(saves.at(-1).state.status, "done");
  assert.ok(saves.some(s => s.state.status === "waiting"), "saved while the run was active");
});

test.after(async () => { await mock.close(); });
