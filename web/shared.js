// Shared by the browser UI, the server and the tests. No Node or DOM APIs in here.

// Every taxonomy list the Events API puts on a session (see Session in the OpenAPI spec).
export const TAXONOMY = [
  ['tracks', 'Track'], ['topics', 'Topic'], ['services', 'Service'], ['areasOfInterest', 'Area of interest'],
  ['focusAreas', 'Focus area'], ['industries', 'Industry'], ['roles', 'Role'], ['segments', 'Segment'],
  ['customerPersonas', 'Customer persona'], ['experiences', 'Experience'], ['features', 'Feature'],
  ['additionalActivities', 'Additional activity'],
];
const KNOWN_ARRAYS = new Set([...TAXONOMY.map(t => t[0]), 'speakers']);
export const LEVELS = [100, 200, 300, 400, 500];
export const SEAT_ORDER = ['available', 'limited', 'veryLimited', 'unavailable', 'walkUp', 'notReservable'];
export const SEAT_LABEL = {
  available: 'Seats available', limited: 'Limited seats', veryLimited: 'Very few seats',
  unavailable: 'Full', walkUp: 'Walk-up (no reservation)', notReservable: 'Not reservable yet',
};
// Sessions that lack a level, date, time, venue or type are still filterable, under an explicit "not set" choice.
export const NONE = '__none';
export const NONE_LABEL = { level: 'No level', day: 'No date yet', timeOfDay: 'No time yet', venue: 'Venue not announced', type: 'No type' };

/**
 * The API fills `venue` for some venues only. For the rest the venue is the first part of `room`
 * ("Wynn/Encore | Convention Promenade | Latour 5"), so use that when `venue` is empty.
 */
export function venueOf(s) {
  if (s.venue) return s.venue;
  const first = (s.room || '').split('|')[0].trim();
  return first && !/^level\s*\d/i.test(first) ? first : null;
}
export const TIME_OF_DAY = ['Morning (before 12:00)', 'Afternoon (12:00 to 17:00)', 'Evening (after 17:00)'];

const camelToLabel = k => k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

/** Adds derived fields used for filtering and conflict checks. Safe to call twice. */
export function normalize(raw) {
  const s = { ...raw };
  const t = s.sessionTime || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date || '');
  const hm = /^(\d{1,2}):(\d{2})/.exec(t.time || '');
  s.date = m ? t.date : null;
  s.levelNum = parseInt(s.level, 10) || null;
  s.code = s.abbreviation || s.sessionId;
  s.startMin = s.endMin = null;
  if (m && hm && !s.isAllDaySession) {
    // Minutes since epoch on a naive clock: every session is in the event's own time zone, so ordering and overlap are exact.
    s.startMin = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 60000) + (+hm[1]) * 60 + (+hm[2]);
    s.endMin = s.startMin + (parseInt(t.length, 10) || 0);
  }
  return s;
}

/**
 * AWS runs popular sessions more than once. Showings share a base code and a title: SVS403-R, SVS403-R1, SVS403-R2.
 * Two sessions are repeats of each other when both match, so a different talk that reuses a title is never merged.
 */
export const baseCode = c => String(c || '').replace(/-R\d*$/i, '');
const normTitle = t => String(t || '').toLowerCase().replace(/\s*\[repeat\]\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const repeatKey = s => `${baseCode(s.code)}|${normTitle(s.title)}`;

/**
 * Reads a party time as written on conference listings: "7PM–1AM", "1–4PM", "7:30–8:30PM", "7PM–12AM", "8PM".
 * Returns minutes after midnight on the listed day; `end` can pass 1440 for events that run past midnight. null if it cannot be read.
 * A start without AM/PM takes the end's, unless that would start after the end ("11–2PM" is 11 AM to 2 PM).
 */
export function parseClockRange(text) {
  const t = String(text || '').toUpperCase().replace(/[–—−]/g, '-').replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?(AM|PM)?(?:-(\d{1,2})(?::(\d{2}))?(AM|PM))?$/.exec(t);
  if (!m) return null;
  const to24 = (h, mer) => (mer === 'AM' ? h % 12 : (h % 12) + 12);
  const h1 = +m[1], m1 = +(m[2] || 0);
  if (h1 < 1 || h1 > 12 || m1 > 59) return null;
  if (m[4] === undefined) { // only a start time: "8PM"
    if (!m[3]) return null;
    const start = to24(h1, m[3]) * 60 + m1;
    return { start, end: start + 120, endGuessed: true };
  }
  const h2 = +m[4], m2 = +(m[5] || 0);
  if (h2 < 1 || h2 > 12 || m2 > 59) return null;
  let end = to24(h2, m[6]) * 60 + m2;
  let start;
  if (m[3]) start = to24(h1, m[3]) * 60 + m1;
  else {
    start = to24(h1, m[6]) * 60 + m1;
    if (start >= end) start = to24(h1, m[6] === 'PM' ? 'AM' : 'PM') * 60 + m1;
  }
  if (end <= start) end += 1440; // runs past midnight
  return { start, end };
}

/**
 * Side-by-side placement for blocks that overlap in one day. Each item needs {start, end}; returns the same items with `lane` and `lanes`
 * (how many lanes its overlapping group needs), so width = 1/lanes and left = lane/lanes.
 */
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = []; let group = [], groupEnd = -Infinity;
  const flush = () => {
    const laneEnds = [];
    for (const it of group) {
      let l = laneEnds.findIndex(e => e <= it.start);
      if (l < 0) { l = laneEnds.length; laneEnds.push(it.end); } else laneEnds[l] = it.end;
      it.lane = l;
    }
    group.forEach(it => { it.lanes = laneEnds.length; });
    out.push(...group); group = []; groupEnd = -Infinity;
  };
  for (const it of sorted) {
    if (group.length && it.start >= groupEnd) flush();
    group.push(it); groupEnd = Math.max(groupEnd, it.end);
  }
  if (group.length) flush();
  return out;
}

/** Short stable id from text, so a party keeps the same id every time the page is read. */
export function hashId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const overlaps = (a, b) => a.startMin != null && b.startMin != null && a.startMin < b.endMin && b.startMin < a.endMin;

export function timeOfDay(s) {
  if (s.startMin == null) return null;
  const h = Math.floor(((s.startMin % 1440) + 1440) % 1440 / 60);
  return h < 12 ? TIME_OF_DAY[0] : h < 17 ? TIME_OF_DAY[1] : TIME_OF_DAY[2];
}

export function seatKey(s) {
  if (s.seatAvailability) return s.seatAvailability;
  return s.isReservable === false ? 'notReservable' : null;
}

/**
 * Where a session is, ready to display: the venue (always from venueOf, so Wynn/Encore and Caesars Palace show up even when the
 * API's venue field is empty) and the rest of the room path without repeating the venue ("Convention Promenade › Latour 5").
 */
export function placeOf(s) {
  const venue = venueOf(s);
  const parts = String(s.room || '').split('|').map(x => x.trim()).filter(Boolean);
  if (venue && parts[0] === venue) parts.shift();
  return { venue, where: parts.join(' › ') };
}

/** The values a session has for one facet key. */
export function valuesFor(s, key) {
  switch (key) {
    case 'level': return s.levelNum ? [String(s.levelNum)] : [NONE];
    case 'type': return s.type ? [s.type] : [NONE];
    case 'day': return s.date ? [s.date] : [NONE];
    case 'timeOfDay': return [timeOfDay(s) || NONE];
    case 'seat': return [seatKey(s)].filter(Boolean);
    case 'venue': return [venueOf(s) || NONE];
    case 'speakers': return (s.speakers || []).map(x => x.name).filter(Boolean);
    default: {
      const list = Array.isArray(s[key]) ? s[key].filter(v => typeof v === 'string') : [];
      return list.length || !TAX_KEYS.has(key) ? list : [NONE]; // "not listed" so sessions without this tag stay reachable
    }
  }
}
const TAX_KEYS = new Set(TAXONOMY.map(t => t[0]));

export function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
}

/** Every calendar day from start to end inclusive, as YYYY-MM-DD. */
export function daysBetween(startIso, endIso) {
  const out = [];
  if (!startIso || !endIso) return out;
  const [a, b] = [startIso.slice(0, 10), endIso.slice(0, 10)];
  for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Filter groups. Fixed values (levels 100 to 500, every event day, every seat state) always appear, even at zero sessions.
 * Everything else comes from the catalog, and any extra string-array field the API adds later becomes a group automatically.
 */
export function buildFacets(sessions, event) {
  const uniq = key => [...new Set(sessions.flatMap(s => valuesFor(s, key)))].filter(v => v !== NONE).sort((a, b) => a.localeCompare(b));
  const hasNone = key => sessions.some(s => valuesFor(s, key).includes(NONE));
  const withNone = (key, values, label) => (hasNone(key) ? [...values, { value: NONE, label: NONE_LABEL[key] || `No ${(label || key).toLowerCase()} listed` }] : values);
  const levelNames = {};
  sessions.forEach(s => { if (s.levelNum) levelNames[s.levelNum] = s.level; });
  const levelVals = [...new Set([...LEVELS, ...sessions.map(s => s.levelNum).filter(Boolean)])].sort((a, b) => a - b);
  const days = [...new Set([...daysBetween(event?.startDate, event?.endDate), ...sessions.map(s => s.date).filter(Boolean)])].sort();
  const groups = [
    { key: 'level', label: 'Level', values: withNone('level', levelVals.map(n => ({ value: String(n), label: levelNames[n] || String(n) }))) },
    { key: 'day', label: 'Day', values: withNone('day', days.map(d => ({ value: d, label: dayLabel(d) }))) },
    { key: 'timeOfDay', label: 'Time of day', values: withNone('timeOfDay', TIME_OF_DAY.map(v => ({ value: v, label: v }))) },
    { key: 'type', label: 'Session type', values: withNone('type', uniq('type').map(v => ({ value: v, label: v }))) },
    { key: 'seat', label: 'Seats', values: SEAT_ORDER.map(v => ({ value: v, label: SEAT_LABEL[v] })) },
  ];
  for (const [key, label] of TAXONOMY) groups.push({ key, label, values: withNone(key, uniq(key).map(v => ({ value: v, label: v })), label) });
  groups.push({ key: 'venue', label: 'Venue', values: withNone('venue', uniq('venue').map(v => ({ value: v, label: v }))) });
  groups.push({ key: 'speakers', label: 'Speaker', values: uniq('speakers').map(v => ({ value: v, label: v })) });
  // Anything else AWS adds as a list of strings.
  const extra = new Set();
  sessions.forEach(s => Object.entries(s).forEach(([k, v]) => {
    if (Array.isArray(v) && v.length && typeof v[0] === 'string' && !KNOWN_ARRAYS.has(k)) extra.add(k);
  }));
  for (const key of [...extra].sort()) groups.push({ key, label: camelToLabel(key), values: uniq(key).map(v => ({ value: v, label: v })) });
  return groups.filter(g => g.values.length);
}

/** Filters are hard rules: AND between groups, OR inside a group. `skip` leaves one group out (used for facet counts). */
export function matchesFilters(s, filters, skip) {
  for (const [key, chosen] of Object.entries(filters)) {
    if (key === skip || !chosen || !chosen.length) continue;
    const have = valuesFor(s, key);
    if (!chosen.some(v => have.includes(v))) return false;
  }
  return true;
}

/* ---------------- search: a session must contain a typed word to appear; more words and better places rank higher ---------------- */
// Everyday words that say nothing about a session. Two-letter words are listed here so "AI", "ML" and "S3" are kept but "of" and "on" are not.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'not', 'about', 'session', 'sessions', 'want', 'show', 'find', 'give', 'need', 'level',
  'an', 'as', 'at', 'be', 'by', 'do', 'go', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  // Words people type around what they mean ("best sessions for ...", "how to ..."). Requiring them would hide good results.
  'best', 'top', 'good', 'great', 'latest', 'recommended', 'recommend', 'relevant', 'related', 'how', 'what', 'why', 'who', 'when', 'where', 'which',
  'can', 'will', 'would', 'should', 'could', 'you', 'your', 'our', 'have', 'has', 'any', 'all', 'some', 'more', 'most', 'very', 'using', 'use', 'get',
  'look', 'looking', 'talk', 'talks', 'please']);
const stem = w => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const reCache = new Map();
/**
 * A word matches where it STARTS a word: "agent" finds "agentic" and "multi-agent", "serverles" finds "serverless".
 * A two-letter word must be the whole word: "ai" finds "AI" and "AI-powered" but not "aim" or "said".
 */
function wordRe(term) {
  let re = reCache.get(term);
  if (!re) { re = new RegExp('(^|[^a-z0-9])' + escRe(term) + (term.length <= 2 ? '($|[^a-z0-9])' : '')); reCache.set(term, re); }
  return re;
}

/** Turns what was typed into search terms. `term` is the form used for matching, `shown` is the word as typed. */
export function parseQuery(text) {
  const seen = new Map();
  for (const w of (text || '').split(/[^A-Za-z0-9-]+/)) {
    const raw = w.toLowerCase(), t = stem(raw);
    if (t.length < 2 || STOP.has(t) || STOP.has(raw) || seen.has(t)) continue;
    seen.set(t, raw);
  }
  return [...seen].map(([term, shown]) => ({ term, shown }));
}

function haystack(s) {
  return {
    title: (s.title || '').toLowerCase(),
    code: (s.code || '').toLowerCase(),
    tags: [...TAXONOMY.map(t => t[0]).flatMap(k => valuesFor(s, k)), ...valuesFor(s, 'speakers')].filter(v => v !== NONE).join(' | ').toLowerCase(),
    abs: (s.abstract || '').toLowerCase(),
    kind: `${s.type || ''} ${s.level || ''}`.toLowerCase(),
  };
}

const hasWord = (text, term) => wordRe(term).test(text);

export function scoreSession(s, terms, profile = { likes: [], skips: [] }) {
  const h = haystack(s), hits = [];
  let text = 0;
  for (const { term } of terms) {
    let m = 0;
    if (h.code === term || h.code.startsWith(term + '-')) m += 8;
    if (hasWord(h.title, term)) m += 4;
    if (hasWord(h.tags, term)) m += 3;
    if (hasWord(h.abs, term)) m += 1;
    if (hasWord(h.kind, term)) m += 1;
    if (m) { text += m; hits.push(term); }
  }
  let prof = 0;
  for (const w of profile.likes || []) if (hasWord(h.title, w) || hasWord(h.tags, w)) prof += 1.5;
  for (const w of profile.skips || []) if (hasWord(h.title, w) || hasWord(h.tags, w)) prof -= 3;
  // Sessions that fill first get a small nudge, but only when the person asked for something.
  const seat = text ? ({ veryLimited: 0.6, limited: 0.3 }[s.seatAvailability] || 0) : 0;
  // A session "contains every word" when it matched all the typed terms. The page shows only those unless partial matches are switched on.
  return { score: text + prof + seat, hits, prof, all: terms.length > 0 && hits.length === terms.length };
}
