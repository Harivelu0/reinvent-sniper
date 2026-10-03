import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacets, matchesFilters, normalize, parseQuery, scoreSession, daysBetween, overlaps } from '../web/shared.js';
import { makeSessions, EVENT } from '../mock/mock-events.js';

const sessions = makeSessions(60).map(normalize);

test('levels 100 to 500 always appear, even when the catalog has no 500', () => {
  const g = buildFacets(sessions, EVENT).find(x => x.key === 'level');
  assert.deepEqual(g.values.map(v => v.value), ['100', '200', '300', '400', '500']);
});

test('every re:Invent day appears, taken from the event dates', () => {
  const g = buildFacets([], EVENT).find(x => x.key === 'day');
  assert.deepEqual(g.values.map(v => v.value), ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']);
  assert.equal(g.values[0].label, 'Mon, Nov 30');
});

test('a day with sessions outside the event range is still offered', () => {
  const extra = [normalize({ ...makeSessions(1)[0], sessionTime: { date: '2026-11-29', time: '10:00', length: '60' } })];
  const g = buildFacets(extra, EVENT).find(x => x.key === 'day');
  assert.ok(g.values.some(v => v.value === '2026-11-29'));
});

test('every taxonomy list from the API gets a filter group when it has values', () => {
  const s = normalize({ ...makeSessions(1)[0], industries: ['Gaming'], roles: ['Developer'], focusAreas: ['Cost'], customerPersonas: ['Startup'] });
  const keys = buildFacets([s], EVENT).map(g => g.key);
  for (const k of ['industries', 'roles', 'focusAreas', 'customerPersonas', 'topics', 'services', 'tracks', 'type', 'venue', 'speakers', 'seat', 'timeOfDay']) assert.ok(keys.includes(k), `missing ${k}`);
});

test('a new string-list field AWS adds later becomes a filter automatically', () => {
  const s = normalize({ ...makeSessions(1)[0], languages: ['English', 'Japanese'] });
  const g = buildFacets([s], EVENT).find(x => x.key === 'languages');
  assert.ok(g);
  assert.equal(g.label, 'Languages');
});

test('filters are AND between groups and OR inside a group', () => {
  const lvl = sessions.filter(s => matchesFilters(s, { level: ['300', '400'] }));
  assert.ok(lvl.length && lvl.every(s => [300, 400].includes(s.levelNum)));
  const both = sessions.filter(s => matchesFilters(s, { level: ['300', '400'], day: ['2026-12-01'] }));
  assert.ok(both.length && both.every(s => [300, 400].includes(s.levelNum) && s.date === '2026-12-01'));
  assert.equal(sessions.filter(s => matchesFilters(s, {})).length, sessions.length);
});

test('words reorder sessions but never remove them', () => {
  const terms = parseQuery('serverless cost');
  const scored = sessions.map(s => ({ s, ...scoreSession(s, terms) })).sort((a, b) => b.score - a.score);
  assert.equal(scored.length, sessions.length);
  assert.ok(scored[0].hits.length > 0);
  assert.ok(scored[0].score >= scored.at(-1).score);
});

test('profile interests lift sessions and exclusions push them down', () => {
  const s = sessions[0];
  const up = scoreSession(s, [], { likes: [s.topics[0].toLowerCase()], skips: [] });
  const down = scoreSession(s, [], { likes: [], skips: [s.topics[0].toLowerCase()] });
  assert.ok(up.score > 0 && down.score < 0);
});

test('a repeated word is only searched once, and the typed form is kept for display', () => {
  const t = parseQuery('Serverless serverless SERVERLESS cost');
  assert.deepEqual(t.map(x => x.shown), ['serverless', 'cost']);
  assert.equal(t[0].term, 'serverles', 'plural-ish endings are trimmed for matching only');
});

test('overlap uses real clock times and ignores all-day sessions', () => {
  const a = normalize({ sessionId: 'a', sessionTime: { date: '2026-12-01', time: '09:00', length: '60' } });
  const b = normalize({ sessionId: 'b', sessionTime: { date: '2026-12-01', time: '09:30', length: '60' } });
  const c = normalize({ sessionId: 'c', sessionTime: { date: '2026-12-01', time: '10:00', length: '60' } });
  const d = normalize({ sessionId: 'd', isAllDaySession: true, sessionTime: { date: '2026-12-01', time: '00:00', length: '1440' } });
  assert.ok(overlaps(a, b)); assert.ok(!overlaps(a, c)); assert.ok(!overlaps(a, d));
});

test('daysBetween is inclusive', () => assert.equal(daysBetween('2026-11-30T05:30:00.000-08:00', '2026-12-04T23:59:00.000-08:00').length, 5));

import { venueOf, NONE } from '../web/shared.js';

test('venue is read from the room when the API leaves venue empty (Wynn/Encore, Caesars Palace)', () => {
  assert.equal(venueOf({ venue: 'MGM Grand', room: 'Level 3 | Chairman 363' }), 'MGM Grand');
  assert.equal(venueOf({ room: 'Wynn/Encore | Convention Promenade | Latour 5' }), 'Wynn/Encore');
  assert.equal(venueOf({ room: 'Caesars Palace | Promenade South | Octavius 4 | Content Hub | Red Theater' }), 'Caesars Palace');
  assert.equal(venueOf({ room: 'Level 2 | Hall B | Expo' }), null);
  assert.equal(venueOf({}), null);
});

test('all five venues appear as filters, with a choice for sessions whose venue is not announced', () => {
  const base = makeSessions(1)[0];
  const mk = o => normalize({ ...base, venue: undefined, ...o });
  const list = [
    mk({ venue: 'MGM Grand' }), mk({ venue: 'Caesars Forum' }), mk({ venue: 'Venetian' }),
    mk({ room: 'Wynn/Encore | Convention Promenade | Latour 5' }),
    mk({ room: 'Caesars Palace | Promenade South | Octavius 4' }),
    mk({ room: undefined }),
  ];
  const g = buildFacets(list, EVENT).find(x => x.key === 'venue');
  assert.deepEqual(g.values.map(v => v.label), ['Caesars Forum', 'Caesars Palace', 'MGM Grand', 'Venetian', 'Wynn/Encore', 'Venue not announced']);
  assert.equal(list.filter(s => matchesFilters(s, { venue: ['Wynn/Encore'] })).length, 1);
  assert.equal(list.filter(s => matchesFilters(s, { venue: [NONE] })).length, 1);
});

test('sessions with no level or no date can still be found', () => {
  const base = makeSessions(1)[0];
  const noLevel = normalize({ ...base, level: 'No Level' });
  const noDate = normalize({ ...base, sessionTime: undefined });
  const facets = buildFacets([noLevel, noDate], EVENT);
  assert.ok(facets.find(g => g.key === 'level').values.some(v => v.value === NONE));
  assert.ok(facets.find(g => g.key === 'day').values.some(v => v.value === NONE));
  assert.ok(matchesFilters(noLevel, { level: [NONE] }));
  assert.ok(!matchesFilters(noLevel, { level: ['300'] }));
  assert.ok(matchesFilters(noDate, { day: [NONE] }));
});

import { repeatKey, baseCode } from '../web/shared.js';

test('showings of one talk share a repeat key; different talks never do', () => {
  const a = { code: 'SVS403-R', title: 'Building stateful AI workflows with Serverless orchestration' };
  const b = { code: 'SVS403-R1', title: 'Building stateful AI workflows with Serverless orchestration' };
  const c = { code: 'SVS403-R2', title: 'Building stateful AI workflows with Serverless orchestration [REPEAT]' };
  assert.equal(repeatKey(a), repeatKey(b));
  assert.equal(repeatKey(a), repeatKey(c), 'a [REPEAT] suffix in the title does not split the group');
  // same title, different base code: a different talk that happens to share a title
  assert.notEqual(repeatKey(a), repeatKey({ code: 'DAT100-R', title: a.title }));
  // same base code, different title: not merged either
  assert.notEqual(repeatKey(a), repeatKey({ code: 'SVS403-R3', title: 'Something else entirely' }));
  assert.equal(baseCode('ARC202-R2'), 'ARC202');
  assert.equal(baseCode('AIM459-S'), 'AIM459-S', 'only -R / -R<number> suffixes are repeats');
});

import { placeOf } from '../web/shared.js';

test('placeOf shows the venue even when the API leaves it empty, without repeating it in the room path', () => {
  // venue only in the room text (Wynn/Encore, Caesars Palace)
  assert.deepEqual(
    placeOf({ room: "Wynn/Encore | Upper Convention Promenade | Cristal 2 | Content Hub | Builders' Session 2" }),
    { venue: 'Wynn/Encore', where: "Upper Convention Promenade › Cristal 2 › Content Hub › Builders' Session 2" });
  // venue field present: the room path stays whole
  assert.deepEqual(
    placeOf({ venue: 'Caesars Forum', room: 'Level 1 | Alliance 311' }),
    { venue: 'Caesars Forum', where: 'Level 1 › Alliance 311' });
  // venue field present and the room also starts with it: not repeated
  assert.deepEqual(placeOf({ venue: 'Wynn/Encore', room: 'Wynn/Encore | Latour 5' }), { venue: 'Wynn/Encore', where: 'Latour 5' });
  // nothing known yet
  assert.deepEqual(placeOf({}), { venue: null, where: '' });
});

const sess = o => normalize({ ...makeSessions(1)[0], services: [], topics: [], roles: [], tracks: [], speakers: [], abstract: '', ...o });
const matches = (s, q) => scoreSession(s, parseQuery(q)).hits.length > 0;

test('two-letter terms like AI, ML and S3 work, as whole words only', () => {
  assert.ok(matches(sess({ title: 'Building AI agents' }), 'AI'));
  assert.ok(matches(sess({ title: 'AI-powered search' }), 'ai'));
  assert.ok(!matches(sess({ title: 'Aim higher, said the speaker' }), 'AI'), '"ai" must not match inside "aim" or "said"');
  assert.ok(matches(sess({ services: ['Amazon S3'] }), 'S3'));
  assert.ok(matches(sess({ topics: ['ML'] }), 'ml'));
});

test('everyday two-letter words are ignored, so they never match everything', () => {
  assert.deepEqual(parseQuery('what to do on the AI of it').map(t => t.term), ['ai'], '"what", "to", "do", "on", "the", "of", "it" are all ignored');
  assert.deepEqual(parseQuery('of on in to'), []);
});

test('a word matches where a word starts: agent finds agentic, serverles finds serverless', () => {
  assert.ok(matches(sess({ title: 'Agentic workflows' }), 'agent'));
  assert.ok(matches(sess({ title: 'Multi-agent systems' }), 'agent'));
  assert.ok(matches(sess({ title: 'Serverless at scale' }), 'serverless'));
  assert.ok(!matches(sess({ title: 'Rapid capital markets' }), 'api'), '"api" must not match inside "rapid" or "capital"');
});

test('a session with every typed word ranks above one with a single word, and zero-match sessions have no hits', () => {
  const t = parseQuery('serverless cost');
  const both = scoreSession(sess({ title: 'Serverless cost control' }), t);
  const one = scoreSession(sess({ title: 'Serverless basics' }), t);
  const none = scoreSession(sess({ title: 'Networking deep dive' }), t);
  assert.ok(both.score > one.score && one.score > none.score);
  assert.equal(none.hits.length, 0, 'the page hides sessions with no hits unless asked');
});

test('searching a session code finds every showing of it', () => {
  const t = parseQuery('SVS403');
  assert.ok(scoreSession(sess({ abbreviation: 'SVS403-R', code: 'SVS403-R' }), t).hits.length);
  assert.ok(scoreSession(sess({ abbreviation: 'SVS403-R1', code: 'SVS403-R1' }), t).hits.length);
  assert.ok(!scoreSession(sess({ abbreviation: 'SVS404-R', code: 'SVS404-R' }), t).hits.length);
});

test('the typed word is kept for display even though matching uses a shortened form', () => {
  const t = parseQuery('serverless');
  assert.equal(t[0].shown, 'serverless');
  assert.equal(t[0].term, 'serverles');
});

test('filler words like "best" and "how" are not required, so natural sentences still work', () => {
  assert.deepEqual(parseQuery('the best sessions for agentic AI on Lambda').map(t => t.shown), ['agentic', 'ai', 'lambda']);
  assert.deepEqual(parseQuery('how to use Lambda').map(t => t.shown), ['lambda']);
  assert.deepEqual(parseQuery('best sessions'), [], 'a query of only filler words searches nothing');
});

test('"all" is true only when every typed word is found', () => {
  const t = parseQuery('serverless cost');
  const both = scoreSession(sess({ title: 'Serverless cost control' }), t);
  const one = scoreSession(sess({ title: 'Serverless basics' }), t);
  const none = scoreSession(sess({ title: 'Networking deep dive' }), t);
  assert.equal(both.all, true);
  assert.equal(one.all, false);
  assert.equal(one.hits.length, 1, 'a partial match still reports which word matched');
  assert.equal(none.all, false);
  assert.equal(none.hits.length, 0);
  assert.equal(scoreSession(sess({ title: 'Anything' }), []).all, false, 'with no search words nothing counts as a match');
});
