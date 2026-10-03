import { hashId, parseClockRange } from '../web/shared.js';
import { readJson, writeJson } from './store.js';

// An unofficial community list of re:Invent parties. It is copyrighted by its owner, so this app never ships a copy of it:
// the person using the app fetches the page themselves, once per click, and keeps the result only on their own computer.
export const PARTIES_URL = 'https://conferenceparties.com/reinvent2026/';
export const PARTIES_SOURCE = { name: 'conferenceparties.com', url: PARTIES_URL };

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const TIME_RANGE = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i;
const STATUS = /\b(?:Sorry\.?\s*)?(At Capacity|Sold Out|Waitlist(?: Only)?)\b\.?/i;

const decode = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&#8216;|&#8217;|&rsquo;|&lsquo;/g, "'").replace(/&#8220;|&#8221;/g, '"')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Visible text of an HTML fragment as trimmed, non-empty lines (a <br> starts a new line). */
const lines = html => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  .split('\n').map(x => x.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);

/**
 * Reads the listing page: one table, a heading row per day ("Monday - November 30, 2026"), then one row per event with
 * five cells: time, sponsor, event (often a link), location, date added. Banner rows and blank rows are skipped.
 */
export function parsePartiesHtml(html) {
  const events = [];
  let date = null;
  for (const row of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const inner = row[1];
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    if (h2) {
      const m = /([A-Za-z]+)\s*[-–]\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(lines(h2[1]).join(' '));
      date = m && MONTHS[m[2].toLowerCase()] ? `${m[4]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}` : null;
      continue;
    }
    const cells = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]);
    if (!date || cells.length < 4) continue;
    const timeText = lines(cells[0]).join(' ');
    if (!timeText || /^time$/i.test(timeText)) continue; // header row or blank row
    // The time cell sometimes carries a note ("7:30PM-12AM Shuttles 7PM"). Read the range and keep the rest as a note.
    const rangeText = TIME_RANGE.exec(timeText)?.[0] || timeText;
    const timeNote = timeText.replace(rangeText, '').trim();
    const sponsor = lines(cells[1]).join(' ');
    const eventLines = lines(cells[2]).map(l => l.replace(/\s*[-–]?\s*Request an Invite\s*$/i, '').trim()).filter(Boolean);
    let name = eventLines.join(' ');
    // "Sorry. At Capacity" is a status written into the name. Keep it as a status so it can be shown as a warning.
    const cap = STATUS.exec(name);
    const status = cap ? cap[1] : '';
    if (cap) name = name.replace(STATUS, '').replace(/\s{2,}/g, ' ').trim();
    if (!name) continue;
    const href = /href="([^"]+)"/i.exec(cells[2]);
    const placeLines = lines(cells[3]);
    const place = placeLines.some(l => /Register to See Address/i.test(l)) ? 'Address shared after you register' : placeLines.join(', ');
    const clock = parseClockRange(rangeText);
    events.push({
      id: 'party-' + hashId(`${date}|${timeText}|${sponsor}|${name}`),
      date, timeText: rangeText, timeNote, start: clock?.start ?? null, end: clock?.end ?? null, endGuessed: Boolean(clock?.endGuessed),
      sponsor, name, status, venue: placeLines[0] || '', place,
      rsvpUrl: href ? decode(href[1]) : null,
      inviteRequired: /Request an Invite/i.test(cells[2]),
      added: lines(cells[4] || '').join(' '),
    });
  }
  if (!events.length) throw new Error('Could not read any parties from the page. The site may have changed its layout.');
  return events;
}

export const getParties = () => readJson('parties.json', null);

/** Fetches the listing and keeps it on this computer. Called only when the person presses the button. */
export async function fetchParties() {
  const res = await fetch(PARTIES_URL, {
    headers: { 'User-Agent': 'Reinvent Sniper (a personal re:Invent planner; fetched by the attendee, not republished)', Accept: 'text/html' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`conferenceparties.com answered ${res.status}. Try again later.`);
  const events = parsePartiesHtml(await res.text());
  const saved = { fetchedAt: new Date().toISOString(), source: PARTIES_SOURCE, events };
  writeJson('parties.json', saved);
  return saved;
}
