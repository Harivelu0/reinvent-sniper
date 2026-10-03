import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClockRange, layoutDay, hashId } from '../web/shared.js';
import { parsePartiesHtml } from '../src/parties.js';

test('party times are read the way people write them', () => {
  const t = s => parseClockRange(s);
  assert.deepEqual(t('7PM–1AM'), { start: 1140, end: 1500 }, 'runs past midnight');
  assert.deepEqual(t('1–4PM'), { start: 780, end: 960 }, 'start borrows PM from the end');
  assert.deepEqual(t('7:30–8:30PM'), { start: 1170, end: 1230 });
  assert.deepEqual(t('7PM–12AM'), { start: 1140, end: 1440 }, 'ends at midnight');
  assert.deepEqual(t('11–2PM'), { start: 660, end: 840 }, '11 to 2PM is 11 AM, not 11 PM');
  assert.deepEqual(t('12–2PM'), { start: 720, end: 840 });
  assert.deepEqual(t('10AM–12PM'), { start: 600, end: 720 });
  assert.deepEqual(t('9 - 11 am'.replace('am', 'AM')), { start: 540, end: 660 });
  assert.deepEqual(t('8PM'), { start: 1200, end: 1320, endGuessed: true }, 'only a start: end is a guess and flagged');
  for (const bad of ['TBD', 'All Day', '', null, 'Evening', '13PM–1AM']) assert.equal(t(bad), null, String(bad));
});

test('overlapping blocks are placed side by side, others keep the full width', () => {
  const out = layoutDay([
    { id: 'a', start: 540, end: 660 },   // 9:00-11:00
    { id: 'b', start: 570, end: 630 },   // 9:30-10:30 overlaps a
    { id: 'c', start: 600, end: 720 },   // 10:00-12:00 overlaps a and b
    { id: 'd', start: 780, end: 840 },   // alone
  ]);
  const by = Object.fromEntries(out.map(x => [x.id, x]));
  assert.equal(by.a.lanes, 3); assert.equal(by.b.lanes, 3); assert.equal(by.c.lanes, 3);
  assert.deepEqual([by.a.lane, by.b.lane, by.c.lane].sort(), [0, 1, 2], 'three different lanes');
  assert.equal(by.d.lanes, 1); assert.equal(by.d.lane, 0);
  // two blocks that only touch (one ends when the next starts) are not overlapping
  const touch = layoutDay([{ id: 'x', start: 600, end: 660 }, { id: 'y', start: 660, end: 720 }]);
  assert.ok(touch.every(i => i.lanes === 1 && i.lane === 0));
  assert.deepEqual(layoutDay([]), []);
});

const FIXTURE = `
<table>
 <tr class="row-1"><td colspan="5"><div><a href="https://ads.example/x"><img src="a.png"></a></div></td></tr>
 <tr class="row-2"><td colspan="5"><h2>Sunday - November 29, 2026</h2></td></tr>
 <tr><td><b>Time</b></td><td><b>Sponsor</b></td><td><b>Event &amp; RSVP Link</b></td><td><b>Location</b></td><td><b>Added</b></td></tr>
 <tr><td>7PM–1AM</td><td>HabileLabs</td><td><a href="https://example.com/kick?utm_source=x&amp;y=1" target="_blank">AWS re:Invent Kickoff Night<br><span class='tip'>Request an Invite</span></a></td><td>Register to See Address</td><td>9/11</td></tr>
 <tr><td colspan="5"><h2>Monday&nbsp;- November 30, 2026</h2></td></tr>
 <tr><td>1–4PM</td><td>ResolveAI</td><td><a href="https://luma.com/abc">Monday Afternoon Mixer:<br>Engineering pre:Invent Party - <span>Request an Invite</span></a></td><td>SushiSAMBA<br>The Venetian</td><td>9/28</td></tr>
 <tr><td>4–7PM</td><td>AWS &amp; Partners</td><td>Welcome Reception</td><td>Expo Hall<br>The Venetian</td><td>8/10</td></tr>
 <tr><td colspan="5"><div class="a-single"><a href="https://ads.example/maze" Title="<center>Join Maze</center>"><img src="b.png"></a></div></td></tr>
 <tr><td><b>7:30–8:30PM</td><td><b>Maze</td><td><b><a href="https://mazehq.com/e">Ferris Wheel Bar<br><span>Request an Invite</span></a></td><td><b>High Roller<br>The LINQ Promenade<br>3545 S Las Vegas Blvd</td><td><b>9/23</td></tr>
 <tr><td></td><td></td><td></td><td></td><td></td></tr>
 <tr><td colspan="5"><div class="section" id="Tuesday"><h2>Tuesday - December 1, 2026</h2></td></tr>
 <tr><td>7:30PM–12AM<br>Shuttles 7PM</td><td>AWS</td><td>re:Play Party</td><td>Festival Grounds</td><td>9/1</td></tr>
 <tr><td>7:15–9:30PM</td><td>Hexaware</td><td>Sorry. At Capacity<br>The Immersive Wizard of Oz at Sphere</td><td>Sphere</td><td>9/2</td></tr>
 <tr><td>Evening</td><td>Somebody</td><td>Mystery Mixer</td><td>TBA</td><td>9/30</td></tr>
</table>`;

test('the listing page is read into dated, timed events', () => {
  const ev = parsePartiesHtml(FIXTURE);
  assert.equal(ev.length, 7, 'banner rows, the header row and the blank row are skipped');
  const [kick, mixer, recep, maze, replay, wizard, mystery] = ev;

  assert.equal(kick.date, '2026-11-29');
  assert.equal(kick.sponsor, 'HabileLabs');
  assert.equal(kick.name, 'AWS re:Invent Kickoff Night', '"Request an Invite" is not part of the name');
  assert.equal(kick.inviteRequired, true);
  assert.equal(kick.place, 'Address shared after you register');
  assert.equal(kick.rsvpUrl, 'https://example.com/kick?utm_source=x&y=1', 'HTML entities in links are decoded');
  assert.deepEqual([kick.start, kick.end], [1140, 1500]);

  assert.equal(mixer.date, '2026-11-30', 'a non-breaking space in the day heading does not break it');
  assert.equal(mixer.name, 'Monday Afternoon Mixer: Engineering pre:Invent Party');
  assert.equal(mixer.venue, 'SushiSAMBA');
  assert.equal(mixer.place, 'SushiSAMBA, The Venetian');

  assert.equal(recep.sponsor, 'AWS & Partners');
  assert.equal(recep.rsvpUrl, null);
  assert.equal(recep.inviteRequired, false);

  assert.equal(maze.name, 'Ferris Wheel Bar', 'an unclosed <b> does not leak into the text');
  assert.deepEqual([maze.start, maze.end], [1170, 1230]);
  assert.equal(maze.place, 'High Roller, The LINQ Promenade, 3545 S Las Vegas Blvd');

  assert.equal(replay.name, 're:Play Party');
  assert.equal(replay.timeText, '7:30PM–12AM', 'the time is read even with a note in the same cell');
  assert.equal(replay.timeNote, 'Shuttles 7PM', 'and the note is kept');
  assert.deepEqual([replay.start, replay.end], [1170, 1440]);

  assert.equal(wizard.name, 'The Immersive Wizard of Oz at Sphere', '"Sorry. At Capacity" is not part of the name');
  assert.equal(wizard.status, 'At Capacity', 'it is kept as a status instead');
  assert.equal(maze.status, '', 'other events have no status');

  assert.equal(mystery.date, '2026-12-01');
  assert.equal(mystery.start, null, 'a time that cannot be read is kept, just not placed on the grid');
  assert.equal(mystery.timeText, 'Evening');

  assert.equal(mystery.date, '2026-12-01');
});

test('ids are stable, so a party you marked as going stays marked after the list is read again', () => {
  const a = parsePartiesHtml(FIXTURE), b = parsePartiesHtml(FIXTURE);
  assert.deepEqual(a.map(e => e.id), b.map(e => e.id));
  assert.equal(new Set(a.map(e => e.id)).size, a.length, 'and unique');
  assert.equal(hashId('x'), hashId('x'));
  assert.notEqual(hashId('x'), hashId('y'));
});

test('a page with no readable events is an error with a clear message, not an empty calendar', () => {
  assert.throws(() => parsePartiesHtml('<html><body>maintenance</body></html>'), /Could not read any parties/);
});
