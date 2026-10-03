import { initCalendar } from './calendar.js';
import { icon, iconButton } from './icons.js';
import { buildFacets, valuesFor, overlaps, parseQuery, scoreSession, dayLabel, SEAT_LABEL, repeatKey, placeOf } from './shared.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIERS = ['Must-have', 'Nice-to-have', 'Backup'];
const FIXED = new Set(['level', 'day', 'timeOfDay', 'seat']);
const PT = 'America/Los_Angeles';
// AWS says reserving does not open through the API until Oct 8 (start of the day, Pacific time), two days after the website release on Oct 6.
const API_OPENS_AT = Date.parse('2026-10-08T07:00:00Z');

const S = {
  snap: null, sessions: [], byId: new Map(), facets: [], v: [], stamp: null,
  filters: {}, fq: {}, showAll: new Set(), q: '', terms: [], sort: 'match', limit: 80,
  plan: [], profile: { likes: [], skips: [] }, loaded: false, settingsFilled: false, mode: 'rehearse', wavesKey: '', logLen: -1,
  going: new Set(), custom: [], parties: null,
  open: null, pendingScroll: null, dismissed: new Set(), showDismissed: false, groupRepeats: true, showPartial: false,
};
let cal = null; // the Calendar tab, created once everything it needs exists (bottom of this file)
const DEFAULT_OPEN = ['level', 'day', 'type', 'topics', 'services', 'seat'];

/* Where you left off (filters, search, sort, open sections, tab, scroll) is saved on this computer and restored on reload. */
let uiTimer;
function saveUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!S.loaded) return; // never save the defaults over what is stored before it has been restored
    const tab = ['sessions', 'calendar', 'book', 'profile'].find(n => !$('#tab-' + n).hidden) || 'sessions';
    const open = S.open ? [...S.open] : $$('#filters details[open]').map(d => d.dataset.g);
    api('/api/ui', { tab, filters: S.filters, q: S.q, sort: S.sort, limit: S.limit, open, showAll: [...S.showAll], fq: S.fq, scrollY: Math.round(window.scrollY), showDismissed: S.showDismissed, groupRepeats: S.groupRepeats, showPartial: S.showPartial }).catch(() => {});
  }, 500);
}

async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Sniper': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || `Request failed (${res.status})`); e.needSignIn = j.needSignIn; throw e; }
  return j;
}

/* ---------------- time helpers ---------------- */
const tzOpt = () => { const t = S.snap?.settings.timezone; return t && t !== 'local' ? t : undefined; };
function fmtZone(ms, tz, withName = false) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(withName ? { timeZoneName: 'short' } : {}) }).format(ms);
}
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function ptInputToIso(v) { // 'YYYY-MM-DDTHH:MM' typed as Pacific time -> UTC ISO
  const guess = Date.parse(v + ':00Z'); if (!Number.isFinite(guess)) return null;
  let t = guess - tzOffset(guess, PT); t = guess - tzOffset(t, PT);
  return new Date(t).toISOString();
}
function isoToPtInput(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(Date.parse(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function clock12(h, m) { const ap = h >= 12 ? 'PM' : 'AM'; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`; }
/** Venue first and bold, then the room path. Same on every card, repeat row and plan item so it can be compared at a glance. */
function placeHtml(s) {
  const { venue, where } = placeOf(s);
  if (!venue && !where) return '<span class="where">Venue not announced yet</span>';
  return `${venue ? `<span class="venue">${esc(venue)}</span>` : ''}${where ? `<span class="where">${esc(where)}</span>` : ''}`;
}
function when(s) {
  if (!s.date) return 'Time not announced';
  if (s.isAllDaySession || s.startMin == null) return `${dayLabel(s.date)} · all day`;
  const sm = ((s.startMin % 1440) + 1440) % 1440, em = ((s.endMin % 1440) + 1440) % 1440;
  return `${dayLabel(s.date)} · ${clock12(Math.floor(sm / 60), sm % 60)} to ${clock12(Math.floor(em / 60), em % 60)}`;
}

/* ---------------- catalog + facets ---------------- */
async function loadCatalog() {
  const j = await api('/api/catalog');
  S.sessions = j.sessions || [];
  S.byId = new Map(S.sessions.map(s => [s.sessionId, s]));
  S.stamp = j.fetchedAt || null;
  rebuildFacets();
}
function rebuildFacets() {
  S.facets = buildFacets(S.sessions, S.snap?.event);
  S.v = S.sessions.map(s => Object.fromEntries(S.facets.map(g => [g.key, valuesFor(s, g.key)])));
  renderFilters(); renderResults(); renderPlan();
}
const passFilters = (i, skip) => {
  for (const [k, chosen] of Object.entries(S.filters)) {
    if (k === skip || !chosen.length) continue;
    const have = S.v[i][k]; if (!have || !chosen.some(x => have.includes(x))) return false;
  }
  return true;
};
// Sessions you marked "Not interested" are out of the list and out of the filter counts, unless you ask to see them.
const isDismissed = i => S.dismissed.has(S.sessions[i].sessionId);
const pass = (i, skip) => passFilters(i, skip) && (S.showDismissed || !isDismissed(i));

let dismissTimer;
function saveDismissed() { clearTimeout(dismissTimer); dismissTimer = setTimeout(() => api('/api/dismissed', { ids: [...S.dismissed] }).catch(() => {}), 300); }
let toastTimer;
function toast(msg, undo) {
  const el = $('#toast'); el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="toastUndo">Undo</button>' : ''}`; el.hidden = false;
  $('#toastUndo')?.addEventListener('click', () => { undo(); el.hidden = true; });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}
function setDismissed(ids, on) {
  ids.forEach(id => on ? S.dismissed.add(id) : S.dismissed.delete(id));
  saveDismissed(); updateCounts(); renderResults();
}

function optsHtml(g) {
  const counts = {};
  for (let i = 0; i < S.sessions.length; i++) if (pass(i, g.key)) for (const x of S.v[i][g.key] || []) counts[x] = (counts[x] || 0) + 1;
  const sel = new Set(S.filters[g.key] || []);
  let list = g.values; const q = (S.fq[g.key] || '').toLowerCase();
  if (q) list = list.filter(v => v.label.toLowerCase().includes(q));
  else if (g.values.length > 10 && !S.showAll.has(g.key)) {
    const top = new Set([...g.values].sort((a, b) => (counts[b.value] || 0) - (counts[a.value] || 0)).slice(0, 10).map(v => v.value));
    list = g.values.filter(v => top.has(v.value) || sel.has(v.value));
  }
  const rows = list.map(v => {
    const n = counts[v.value] || 0, label = g.key === 'seat' ? SEAT_LABEL[v.value] : v.label;
    return `<label class="opt ${n ? '' : 'zero'}"><input type="checkbox" data-k="${esc(g.key)}" value="${esc(v.value)}" ${sel.has(v.value) ? 'checked' : ''}><span class="l">${esc(label)}</span><em>${n}</em></label>`;
  }).join('');
  const more = !q && g.values.length > 10 ? `<button class="showall" data-all="${esc(g.key)}">${S.showAll.has(g.key) ? 'Show fewer' : `Show all ${g.values.length}`}</button>` : '';
  return rows + more;
}
function bindOpts(root) {
  root.querySelectorAll('input[type=checkbox]').forEach(i => i.onchange = () => {
    const k = i.dataset.k; const set = new Set(S.filters[k] || []);
    i.checked ? set.add(i.value) : set.delete(i.value);
    S.filters[k] = [...set]; S.limit = 80;
    refreshFilterCounts(k, i.value); renderResults(); saveUi();
  });
  root.querySelectorAll('[data-all]').forEach(b => b.onclick = () => { const k = b.dataset.all; S.showAll.has(k) ? S.showAll.delete(k) : S.showAll.add(k); const g = S.facets.find(x => x.key === k); root.innerHTML = optsHtml(g); bindOpts(root); saveUi(); });
}
function renderFilters() {
  const el = $('#filters'); const domOpen = new Set($$('#filters details[open]').map(d => d.dataset.g));
  const openKeys = S.open || (domOpen.size ? domOpen : null);
  el.innerHTML = S.facets.map(g => {
    const n = (S.filters[g.key] || []).length;
    const open = openKeys ? openKeys.has(g.key) : DEFAULT_OPEN.includes(g.key);
    const search = g.values.length > 10 ? `<input class="fsearch" data-fs="${esc(g.key)}" type="search" placeholder="Search ${esc(g.label.toLowerCase())}" aria-label="Search ${esc(g.label)}" value="${esc(S.fq[g.key] || '')}">` : '';
    return `<details class="fgroup" data-g="${esc(g.key)}" ${open ? 'open' : ''}><summary>${esc(g.label)}<span>${n || ''}</span></summary>${search}<div class="opts" data-o="${esc(g.key)}">${optsHtml(g)}</div></details>`;
  }).join('') || '<p class="note">Filters appear once the catalog loads.</p>';
  $$('#filters .opts').forEach(bindOpts);
  $$('#filters details').forEach(d => d.addEventListener('toggle', () => { S.open = new Set($$('#filters details[open]').map(x => x.dataset.g)); saveUi(); }));
  $$('#filters .fsearch').forEach(inp => inp.oninput = () => { S.fq[inp.dataset.fs] = inp.value; saveUi(); const box = $(`.opts[data-o="${CSS.escape(inp.dataset.fs)}"]`); box.innerHTML = optsHtml(S.facets.find(g => g.key === inp.dataset.fs)); bindOpts(box); });
}
/** After a toggle, update every group's counts in place and keep keyboard focus where it was. */
function updateCounts() {
  for (const g of S.facets) {
    const box = $(`.opts[data-o="${CSS.escape(g.key)}"]`); if (!box) continue;
    box.innerHTML = optsHtml(g); bindOpts(box);
    const n = (S.filters[g.key] || []).length; const sm = box.closest('details')?.querySelector('summary span'); if (sm) sm.textContent = n || '';
  }
}
function refreshFilterCounts(k, v) {
  updateCounts();
  const again = $(`input[data-k="${CSS.escape(k)}"][value="${CSS.escape(v)}"]`); again?.focus();
}

/* ---------------- results ---------------- */
/**
 * Highlights the whole word that starts with a matched term (the same rule the search uses). Two-letter terms must be the whole word.
 * Text is split first and escaped piece by piece, so "&" and "<" can never break the markup.
 */
function hl(text, hits) {
  const src = String(text ?? '');
  if (!hits.length) return esc(src);
  const alt = hits.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (w.length <= 2 ? '(?![A-Za-z0-9])' : '')).join('|');
  const re = new RegExp('(?<![A-Za-z0-9])((?:' + alt + ')[A-Za-z0-9-]*)', 'ig');
  return src.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
const planTier = id => S.plan.find(p => p.sessionId === id)?.tier;

function renderResults() {
  if (!S.sessions.length) {
    $('#count').textContent = 0; $('#total').textContent = 0;
    $('#results').innerHTML = `<div class="empty">${S.snap?.auth.signedIn ? 'No sessions loaded yet. Press Re-sync catalog under Profile.' : 'Sign in with your Builder ID to load the re:Invent catalog.'}</div>`;
    $('#chips').innerHTML = ''; $('#moreWrap').hidden = true; return;
  }
  // Only "Not interested" takes a session out of the list. Sessions you selected stay where they are, marked as selected.
  let list = [], selected = 0, hiddenByYou = 0, partial = 0;
  for (let i = 0; i < S.sessions.length; i++) {
    if (passFilters(i) && isDismissed(i) && !S.showDismissed) hiddenByYou++;
    if (!pass(i)) continue;
    const scored = scoreSession(S.sessions[i], S.terms, S.profile);
    // Searching narrows the list. A session must contain EVERY word you typed. Sessions with only some of them appear (lower) when you tick the box.
    // A session with none of your words is never shown.
    if (S.terms.length) {
      if (!scored.hits.length) continue;
      if (!scored.all) { partial++; if (!S.showPartial) continue; }
    }
    if (planTier(S.sessions[i].sessionId)) selected++;
    list.push({ s: S.sessions[i], ...scored });
  }
  $('#matchWrap').hidden = !S.terms.length || S.terms.length < 2;
  $('#matchLabel').textContent = `Also show partial matches${partial ? ` (${partial})` : ''}`;
  $('#showPartial').checked = S.showPartial;
  $('#plannedNote').textContent = [selected ? `${selected} selected` : '', hiddenByYou ? `${hiddenByYou} hidden by you` : ''].filter(Boolean).join(' · ');
  $('#dismissWrap').hidden = !S.dismissed.size;
  $('#dismissLabel').textContent = `Show hidden (${S.dismissed.size})`;
  $('#showDismissed').checked = S.showDismissed;
  const start = s => s.startMin ?? Infinity;
  // Best match: sessions with every word come first, then by points, then by time. Partial matches (if shown) always sit below.
  if (S.sort === 'match') list.sort((a, b) => (Number(b.all) - Number(a.all)) || b.score - a.score || start(a.s) - start(b.s));
  if (S.sort === 'time') list.sort((a, b) => start(a.s) - start(b.s));
  if (S.sort === 'seats') { const r = { veryLimited: 0, limited: 1, available: 2 }; list.sort((a, b) => (r[a.s.seatAvailability] ?? 3) - (r[b.s.seatAvailability] ?? 3) || start(a.s) - start(b.s)); }
  $('#count').textContent = list.length; $('#total').textContent = S.sessions.length;

  const chips = [];
  for (const g of S.facets) for (const v of S.filters[g.key] || []) {
    const label = g.values.find(x => x.value === v)?.label || v;
    chips.push(`<span class="chip">${esc(g.label)}: ${esc(g.key === 'seat' ? SEAT_LABEL[v] : label)} <button aria-label="Remove ${esc(label)}" data-rk="${esc(g.key)}" data-rv="${esc(v)}">×</button></span>`);
  }
  if (S.q) chips.push(`<span class="chip">Search: ${esc(S.q)} <button aria-label="Clear search" data-rq="1">×</button></span>`);
  $('#chips').innerHTML = chips.join('');
  $$('#chips button').forEach(b => b.onclick = () => {
    if (b.dataset.rq) { S.q = ''; S.terms = []; $('#askInput').value = ''; renderResults(); saveUi(); return; }
    S.filters[b.dataset.rk] = (S.filters[b.dataset.rk] || []).filter(x => x !== b.dataset.rv); renderFilters(); renderResults(); saveUi();
  });

  const best = new Set(S.sort === 'match' && S.terms.length ? list.filter(x => x.hits.length).slice(0, 3).map(x => x.s.sessionId) : []);
  // The same talk is often scheduled several times (SVS403-R, SVS403-R1). Group them into one card that lists every time it runs.
  let cards;
  if (S.groupRepeats) {
    const byKey = new Map(); cards = [];
    for (const item of list) {
      const k = repeatKey(item.s); const g = byKey.get(k);
      if (!g) { const n = { head: item, rest: [] }; byKey.set(k, n); cards.push(n); } else g.rest.push(item);
    }
    for (const g of cards) { // a showing you already chose becomes the main one, so it shows as Selected
      const all = [g.head, ...g.rest], pick = all.find(x => planTier(x.s.sessionId));
      if (pick && pick !== g.head) { g.rest = all.filter(x => x !== pick); g.head = pick; }
      g.rest.sort((a, b) => start(a.s) - start(b.s));
    }
  } else cards = list.map(item => ({ head: item, rest: [] }));
  if (S.groupRepeats && cards.length < list.length) $('#plannedNote').textContent = [$('#plannedNote').textContent, `${cards.length} talks, repeats grouped`].filter(Boolean).join(' · ');
  const runRow = s => {
    const tier = planTier(s.sessionId), sk = s.seatAvailability || (s.isReservable === false ? 'notReservable' : '');
    return `<div class="run ${tier ? 'selected' : ''}"><div class="runinfo"><span class="code">${esc(s.code)}</span><span class="when">${esc(when(s))}</span><span class="placeline inline">${placeHtml(s)}</span>${sk ? `<span class="seat ${esc(sk)}">${esc(SEAT_LABEL[sk] || sk)}</span>` : ''}${tier ? `<span class="selbadge">Selected · ${esc(tier)}</span>` : ''}</div>
      <div class="runbtns">${tier
        ? `<label class="tiersel">Tier <select data-tier-of="${esc(s.sessionId)}" aria-label="Change tier for ${esc(s.code)}">${TIERS.map(x => `<option ${x === tier ? 'selected' : ''}>${x}</option>`).join('')}</select></label>${iconButton('trash', 'Remove from plan', `data-rmplan="${esc(s.sessionId)}"`, 'danger')}`
        : TIERS.map(t => `<button class="btn tierbtn small" data-add="${esc(s.sessionId)}" data-tier="${esc(t)}">${t}</button>`).join('')}</div></div>`;
  };
  const shown = cards.slice(0, S.limit);
  $('#results').innerHTML = shown.length ? shown.map(({ head: { s, hits, prof }, rest }) => {
    const groupIds = [s.sessionId, ...rest.map(x => x.s.sessionId)].join(',');
    const tier = planTier(s.sessionId); const sk = s.seatAvailability || (s.isReservable === false ? 'notReservable' : '');
    let why = '';
    const typed = w => S.terms.find(t => t.term === w)?.shown || w; // show the word as you typed it, not the shortened form used to match
    if (S.terms.length) {
      const missing = S.terms.filter(t => !hits.includes(t.term)).map(t => t.shown);
      why = `<b>Matches:</b> ${hits.map(w => esc(typed(w))).join(', ')}${missing.length ? ` · <span class="missing">missing: ${missing.map(esc).join(', ')}</span>` : ''}${prof > 0 ? ' · fits your profile' : ''}`;
    }
    else if (prof > 0) why = '<b>Fits your profile</b>'; else if (prof < 0) why = 'Pushed down by your profile';
    const tags = [...(s.services || []), ...(s.topics || [])].slice(0, 6);
    const gone = S.dismissed.has(s.sessionId);
    return `<article class="card ${gone ? 'gone' : ''} ${tier ? 'selected' : ''}">
      <div><div class="meta"><span class="code">${esc(s.code)}</span>${tier ? `<span class="selbadge">Selected · ${esc(tier)}</span>` : ''}${best.has(s.sessionId) ? '<span class="best">Best match</span>' : ''}${rest.length ? `<span class="tag repeats">Runs ${rest.length + 1} times</span>` : ''}${s.type ? `<span class="tag">${esc(s.type)}</span>` : ''}${s.level ? `<span class="tag">Level ${esc(s.levelNum || s.level)}</span>` : ''}${sk ? `<span class="seat ${esc(sk)}">${esc(SEAT_LABEL[sk] || sk)}</span>` : ''}</div>
      <h3 style="margin-top:6px">${hl(s.title, hits)}</h3>
      <div class="meta" style="margin-top:4px"><span class="when">${esc(when(s))}</span></div>
      <div class="placeline">${placeHtml(s)}</div>
      ${tags.length ? `<div class="meta" style="margin-top:4px">${tags.map(t => `<span class="tag">${hl(t, hits)}</span>`).join('')}</div>` : ''}</div>
      <div class="act">${tier
        ? `<span class="inplan">✓ In your plan</span><label class="tiersel">Tier <select data-tier-of="${esc(s.sessionId)}" aria-label="Change tier for ${esc(s.code)}">${TIERS.map(x => `<option ${x === tier ? 'selected' : ''}>${x}</option>`).join('')}</select></label><button class="btn ghost" data-rmplan="${esc(s.sessionId)}" title="Remove from plan">${icon('trash')}Remove from plan</button>`
        : gone
          ? `<span class="addlabel">Hidden by you</span><button class="btn" data-restore="${esc(groupIds)}">Show again</button>`
          : `<span class="addlabel">Add to plan as</span>${TIERS.map(t => `<button class="btn tierbtn" data-add="${esc(s.sessionId)}" data-tier="${esc(t)}">${t}</button>`).join('')}<button class="btn ghost" data-hide="${esc(groupIds)}" title="${rest.length ? 'Remove this talk and its repeats from your list' : 'Remove this session from your list'}">Not interested</button>`}</div>
      ${why ? `<div class="why">${why}</div>` : ''}
      ${s.abstract ? `<details class="abs"><summary>Abstract</summary><p>${esc(s.abstract)}</p></details>` : ''}
      ${rest.length ? `<div class="runs"><div class="runslabel">Also runs ${rest.length === 1 ? 'at another time' : `${rest.length} more times`}</div>${rest.map(x => runRow(x.s)).join('')}</div>` : ''}
    </article>`;
  }).join('') : '<div class="empty">No sessions match every filter. Remove one to widen the list.</div>';
  $$('[data-add]').forEach(b => b.onclick = () => setTier(b.dataset.add, b.dataset.tier));
  $$('[data-rmplan]').forEach(b => b.onclick = () => setTier(b.dataset.rmplan, null));
  $$('#results [data-tier-of]').forEach(sel => sel.onchange = () => setTier(sel.dataset.tierOf, sel.value));
  $$('[data-hide]').forEach(b => b.onclick = () => { // hides the talk and all its repeats together
    const ids = b.dataset.hide.split(','), code = S.byId.get(ids[0])?.code || 'Session';
    setDismissed(ids, true); toast(`Hidden ${code}${ids.length > 1 ? ` and ${ids.length - 1} repeat${ids.length > 2 ? 's' : ''}` : ''}.`, () => setDismissed(ids, false));
  });
  $$('[data-restore]').forEach(b => b.onclick = () => setDismissed(b.dataset.restore.split(','), false));
  $('#moreWrap').hidden = cards.length <= S.limit;
  $('#more').textContent = `Show ${Math.min(80, cards.length - S.limit)} more`;
  if (S.pendingScroll != null && S.sessions.length) { const y = S.pendingScroll; S.pendingScroll = null; requestAnimationFrame(() => window.scrollTo(0, y)); }
}

/* ---------------- plan ---------------- */
let saveTimer;
function savePlanSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/api/plan', { items: S.plan }).catch(() => {}), 300); }
/** Put a session in a tier, move it to another tier, or (tier = null) take it out of the plan. */
function setTier(id, tier) {
  S.plan = S.plan.filter(p => p.sessionId !== id);
  if (tier) { S.plan.push({ sessionId: id, tier }); if (S.dismissed.delete(id)) saveDismissed(); } // choosing a session un-hides it
  savePlanSoon(); renderResults(); renderPlan();
}
function planSessions(tier) { return S.plan.filter(p => (!tier || p.tier === tier) && S.byId.has(p.sessionId)).map(p => S.byId.get(p.sessionId)); }
function clashMap() {
  const main = S.plan.filter(p => p.tier !== 'Backup').map(p => S.byId.get(p.sessionId)).filter(Boolean); const out = {};
  for (let i = 0; i < main.length; i++) for (let j = i + 1; j < main.length; j++) if (overlaps(main[i], main[j])) { (out[main[i].sessionId] ??= []).push(main[j].code); (out[main[j].sessionId] ??= []).push(main[i].code); }
  return out;
}
/** Everything you need to judge a session without leaving the plan board. Stays open across re-renders. */
const planOpen = new Set();
function planDetails(s) {
  const names = (s.speakers || []).map(x => x.name).filter(Boolean);
  const tags = [...(s.services || []), ...(s.topics || [])];
  return `<details class="abs plandet" data-pd="${esc(s.sessionId)}" ${planOpen.has(s.sessionId) ? 'open' : ''}><summary>Read details</summary>
    <div class="dmeta">${[s.type, s.level].filter(Boolean).map(esc).join(' · ')}</div>
    ${tags.length ? `<div class="dmeta">${tags.map(esc).join(', ')}</div>` : ''}
    ${names.length ? `<div class="dmeta">Speakers: ${names.slice(0, 6).map(esc).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}</div>` : ''}
    ${s.abstract ? `<p>${esc(s.abstract)}</p>` : '<p class="dmeta">No abstract published.</p>'}</details>`;
}
function renderPlan() {
  const cl = clashMap(); let html = '';
  for (const t of TIERS) {
    const items = planSessions(t);
    html += `<div class="tier"><h4>${t}<span>${items.length}</span></h4>` + (items.length ? items.map(s => {
      let extra = '';
      if (cl[s.sessionId]) extra = `<div class="clash">Clashes with ${esc(cl[s.sessionId].join(', '))}</div>`;
      if (t === 'Backup') {
        const cover = planSessions('Must-have').find(m => overlaps(m, s));
        extra = cover ? `<div class="okmsg">Covers ${esc(cover.code)} if it is full</div>` : '<div class="clash">Not in the same slot as any must-have</div>';
      }
      return `<div class="pitem"><div class="t">${esc(s.code)} · ${esc(s.title)}</div><div class="pwhen">${esc(when(s))}</div><div class="placeline">${placeHtml(s)}</div>${planDetails(s)}<div class="s"><span></span><span class="btns">${iconButton('up', 'Move up', `data-mv="${esc(s.sessionId)}" data-d="-1"`)}${iconButton('down', 'Move down', `data-mv="${esc(s.sessionId)}" data-d="1"`)}${iconButton('trash', 'Remove from plan', `data-rm="${esc(s.sessionId)}"`, 'danger')}</span></div>
        <label class="tiersel">Tier <select data-tier-of="${esc(s.sessionId)}" aria-label="Change tier for ${esc(s.code)}">${TIERS.map(x => `<option ${x === t ? 'selected' : ''}>${x}</option>`).join('')}</select></label>${extra}</div>`;
    }).join('') : '<div class="note">Nothing here yet.</div>') + '</div>';
  }
  $('#plan').innerHTML = html;
  $$('#plan details[data-pd]').forEach(d => d.addEventListener('toggle', () => { d.open ? planOpen.add(d.dataset.pd) : planOpen.delete(d.dataset.pd); }));
  $$('[data-rm]').forEach(b => b.onclick = () => setTier(b.dataset.rm, null));
  $$('#plan [data-tier-of]').forEach(sel => sel.onchange = () => setTier(sel.dataset.tierOf, sel.value));
  $$('[data-mv]').forEach(b => b.onclick = () => {
    const id = b.dataset.mv, d = +b.dataset.d, tier = planTier(id);
    const idxs = S.plan.map((p, i) => p.tier === tier ? i : -1).filter(i => i >= 0);
    const pos = idxs.findIndex(i => S.plan[i].sessionId === id), to = pos + d;
    if (to < 0 || to >= idxs.length) return;
    [S.plan[idxs[pos]], S.plan[idxs[to]]] = [S.plan[idxs[to]], S.plan[idxs[pos]]];
    savePlanSoon(); renderPlan();
  });
  renderChecks(); cal?.render();
}

/* ---------------- header, banner ---------------- */
function renderHeader() {
  const a = S.snap.auth;
  $('#whoami').innerHTML = a.signedIn
    ? `<span class="dot"></span> ${esc(a.email || 'Signed in')} · token refreshes automatically`
    : `<span class="dot off"></span> Not signed in <a class="btn primary" href="/login">Sign in with Builder ID</a>`;
}
const EXPECTED_BUILD = 7;
function renderBanner() {
  const { auth, sync, catalog } = S.snap; let html = '';
  if (S.snap.build !== EXPECTED_BUILD) html = '<div class="banner bad"><div><b>Restart the app to finish updating.</b> The page is newer than the program running behind it, so your filters, hidden sessions and screen position are not being saved yet. In the terminal where it runs: press <b>Ctrl+C</b>, run <b>node server.js</b>, then reload this page (Ctrl+F5).</div></div>';
  else if (!auth.signedIn) html = '<div class="banner info"><b>Sign in to start.</b> Use your AWS Builder ID. Your sign-in stays on this computer. <a class="btn primary" href="/login">Sign in with Builder ID</a></div>';
  else if (sync.running) html = `<div class="banner info"><b>Loading the catalog…</b> ${sync.fetched}${sync.total ? ' of ' + sync.total : ''} sessions<div class="progress"><i style="width:${sync.total ? Math.round(sync.fetched / sync.total * 100) : 5}%"></i></div></div>`;
  else if (sync.error) html = `<div class="banner bad"><b>Catalog sync failed.</b> ${esc(sync.error)} <button class="btn" id="retrySync">Try again</button></div>`;
  else if (!catalog) html = '<div class="banner info"><b>No catalog yet.</b> <button class="btn primary" id="retrySync">Load the catalog</button></div>';
  else if (catalog.warnings?.length) html = `<div class="banner warn"><b>Check the catalog.</b> ${esc(catalog.warnings[0])} <button class="btn" id="retrySync">Re-sync</button></div>`;
  else if (auth.signedIn && auth.refreshExpiresAt - S.snap.now < 3 * 864e5) html = '<div class="banner warn"><b>Your sign-in expires soon.</b> Sign out and sign in again before booking day. <a class="btn" href="/login">Sign in again</a></div>';
  if ($('#banner').innerHTML !== html) { $('#banner').innerHTML = html; $('#retrySync')?.addEventListener('click', startSync); }
}
async function startSync() { try { await api('/api/sync', {}); refresh(); } catch (e) { alert(e.message); } }

/* ---------------- booking: three plain steps ---------------- */
function zoneName() { const t = S.snap?.settings.timezone; return t === 'Asia/Kolkata' ? 'India time' : t === PT ? 'Pacific time' : 'your computer’s time'; }

function renderChecks() {
  if (!S.snap) return;
  const musts = planSessions('Must-have').length, clash = Object.keys(clashMap()).length, s = S.snap;
  const items = [
    [s.auth.signedIn, 'Signed in with your Builder ID.', 'Sign in with your Builder ID first.'],
    [!!s.catalog, `Session list loaded (${s.catalog?.count} sessions).`, 'Load the session list first.'],
    [musts > 0 && !clash,
      musts ? `Your plan has ${musts} must-have${musts > 1 ? 's' : ''} and no overlaps.` : '',
      clash ? 'Two of your sessions overlap. Fix them on the Sessions or Calendar tab.' : 'Add at least one Must-have session to your plan first.'],
    [s.settings.mailReady, `Email is set. The report goes to ${esc(s.settings.sendsTo)}.`,
      'Email is not set up, so you will not get the report. <button class="linkbtn" data-goto="profile">Set it up</button> (it takes a minute).'],
  ];
  const html = items.map(([ok, good, bad]) => `<li><span class="tick ${ok ? '' : 'no'}">${ok ? '✓' : '!'}</span><span>${ok ? good : bad}</span></li>`).join('')
    + '<li><span class="tick no">!</span><span>Keep this computer awake and online, and keep this window open. <button class="linkbtn" id="wake">Stop the screen sleeping</button></span></li>';
  if ($('#checks').dataset.h === html) return;
  $('#checks').dataset.h = html; $('#checks').innerHTML = html;
  $$('#checks [data-goto]').forEach(b => b.onclick = () => showTab(b.dataset.goto));
  $('#wake')?.addEventListener('click', async e => { try { await navigator.wakeLock.request('screen'); e.target.textContent = 'The screen will stay awake while this tab is visible'; } catch { e.target.textContent = 'Your browser refused. Change the computer’s power settings instead.'; } });
}

function renderWaves() {
  const waves = S.snap.settings.waves, key = JSON.stringify(waves) + S.snap.settings.timezone;
  if (key === S.wavesKey || document.activeElement?.closest('#waves')) return;
  S.wavesKey = key; const tz = tzOpt();
  $('#waves').innerHTML = waves.map((w, i) => {
    const ms = Date.parse(w);
    return `<div class="wave"><span class="n">Round ${i + 1}</span><div class="times"><div>${esc(zoneName())} <b>${esc(fmtZone(ms, tz))}</b></div><div>Pacific <b>${esc(fmtZone(ms, PT))}</b></div></div><input type="datetime-local" data-wave="${i}" value="${isoToPtInput(w)}" aria-label="Round ${i + 1}, typed in Pacific time"></div>`;
  }).join('') + '<p class="hint">Type the times in Pacific time (Las Vegas).</p>';
}

/** One plain sentence for where things stand, plus the times in the person's own time zone. */
function renderHero(b) {
  const live = b.mode === 'live', rounds = S.snap.settings.waves.map(w => Date.parse(w));
  let text, cls = '';
  if (b.status === 'waiting' && live) { text = b.wave > 1 ? `Watching: waiting for round ${b.wave}` : 'Watching: waiting for booking to open'; cls = 'wait'; }
  else if (b.status === 'booking') { text = live ? 'Booking your sessions now…' : 'Practice run in progress…'; cls = 'open'; }
  else if (b.status === 'done') { text = live ? 'Finished. See what was booked below.' : 'Practice run finished. Nothing was booked.'; cls = 'open'; }
  else if (b.status === 'error') { text = `Stopped: ${b.error || 'something went wrong'}`; cls = 'bad'; }
  else if (b.status === 'stopped') text = 'Stopped.';
  else text = 'Not started yet';
  const el = $('#bkState'); el.textContent = text; el.className = 'herostate ' + cls;
  $('#bkWhen').textContent = `Through the AWS API, reservations are documented to open on Oct 8. AWS has not said what time, so the app keeps checking. Earliest: ${rounds.map((r, i) => `${rounds.length > 1 ? `Round ${i + 1}: ` : ''}${fmtZone(r, tzOpt())}`).join('. ')} (${zoneName()}).`;
  $('#bkNote').hidden = Date.now() >= API_OPENS_AT;
}

const KIND_WORD = { reserved: 'Booked', backup: 'Booked as backup', full: 'Full', other: 'Not booked' };
function renderBook() {
  const b = S.snap.booking;
  renderWaves(); renderChecks(); renderHero(b);
  const busy = ['waiting', 'booking'].includes(b.status);
  $('#practiceBtn').disabled = busy; $('#liveBtn').disabled = busy; $('#stopBtn').disabled = !busy;
  if (b.log.length !== S.logLen) {
    const el = $('#log'), near = el.scrollHeight - el.scrollTop - el.clientHeight < 40; S.logLen = b.log.length;
    el.innerHTML = b.log.length ? b.log.map(l => `<div><span class="tm">${new Date(l.t).toLocaleTimeString([], { hour12: false })}</span> <span class="${esc(l.level)}">${esc(l.msg)}</span></div>`).join('') : '<span class="tm">Nothing yet.</span>';
    if (near) el.scrollTop = el.scrollHeight;
  }
  const rows = b.rows || [], practice = b.mode !== 'live';
  $('#resultTitle').textContent = rows.length && practice ? 'Practice result (nothing was booked)' : 'What was booked';
  const word = r => (practice && ['reserved', 'backup'].includes(r.kind)) ? (r.kind === 'backup' ? 'Would book as backup' : 'Would book') : (r.status === 'Reserved' ? 'Booked' : r.status === 'Reserved as backup' ? 'Booked as backup' : r.status);
  $('#rows').innerHTML = rows.length ? `<table class="rows">${rows.map(r => `<tr><td class="mono">${esc(r.code)}</td><td>${esc(r.title)}<br><span class="hint">${esc(r.tier || '')}</span></td><td class="k-${esc(r.kind)}">${esc(word(r))}${r.note ? `<br><span class="hint" style="font-weight:400">${esc(r.note)}</span>` : ''}${r.status === 'Backup holds this slot' && !practice ? `<br><button class="btn" data-swap="${esc(r.sessionId)}" style="margin-top:6px">Swap to ${esc(r.code)}</button>` : ''}</td></tr>`).join('')}</table>` : '<span class="hint">Nothing yet. Try a practice run, or start live booking.</span>';
  $$('[data-swap]').forEach(x => x.onclick = async () => {
    if (!confirm('Cancel the backup and book the original session instead? If the original cannot be booked, your backup is put back.')) return;
    try { await api('/api/book/swap', { sessionId: x.dataset.swap }); refresh(); } catch (e) { alert(e.message); }
  });
}

function tickCountdown() {
  if (!S.snap) return;
  const now = Date.now(), next = S.snap.settings.waves.map(w => Date.parse(w)).find(w => w > now), el = $('#bkTime');
  if (!next) { el.textContent = 'Booking should be open'; return; }
  const d = next - now, dd = Math.floor(d / 864e5), h = Math.floor(d % 864e5 / 36e5), m = Math.floor(d % 36e5 / 6e4), s = Math.floor(d % 6e4 / 1e3);
  el.textContent = `${dd}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

/* ---------------- profile ---------------- */
function renderTags() {
  for (const k of ['likes', 'skips']) {
    $('#' + k).innerHTML = S.profile[k].map((w, i) => `<span class="chip ${k === 'skips' ? 'ex' : ''}">${esc(w)} <button aria-label="Remove ${esc(w)}" data-l="${k}" data-i="${i}">×</button></span>`).join('') || '<span class="hint">None yet.</span>';
  }
  $$('#likes button,#skips button').forEach(b => b.onclick = () => { S.profile[b.dataset.l].splice(+b.dataset.i, 1); saveProfile(); });
}
async function saveProfile() { renderTags(); renderResults(); try { await api('/api/profile', S.profile); } catch { /* shown on next sync */ } }

function fillSettings() {
  const st = S.snap.settings; if (S.settingsFilled) return; S.settingsFilled = true;
  // An address saved by an older version may not be a real email (it could be a name). Leave it empty so reports go to your own address.
  $('#mailTo').value = EMAIL_RE.test(st.mailTo || '') ? st.mailTo : ''; $('#smtpUser').value = st.smtpUser; $('#smtpHost').value = st.smtpHost; $('#smtpPort').value = st.smtpPort; $('#tz').value = st.timezone;
  renderPassState();
}
/**
 * The page never receives the saved password back (it stays on this computer), so the box is empty. Make that obvious instead of confusing:
 * a green "Saved" tag, dots in the box like a filled password field, and a line saying how to keep or replace it.
 */
function renderPassState() {
  if (!S.snap) return;
  const saved = S.snap.settings.hasSmtpPass;
  $('#passSaved').hidden = !saved;
  $('#smtpPass').placeholder = saved ? '•'.repeat(16) : '16 letters from Google';
  $('#passHint').innerHTML = saved
    ? 'Your app password is saved on this computer. Leave this box empty to keep it, or type a new one to replace it.'
    : 'This is <b>not</b> your Gmail password. It is a one-time password that Google creates just for this app.';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function setErr(errId, inputId, msg) {
  const e = $('#' + errId), i = $('#' + inputId);
  e.hidden = !msg; e.textContent = msg || ''; i.setAttribute('aria-invalid', msg ? 'true' : 'false');
  return msg ? i : null;
}
/** Checks the three fields that matter, shows a plain message under each one that is wrong, and focuses the first. */
function validateSettings() {
  const user = $('#smtpUser').value.trim(), pass = $('#smtpPass').value.trim(), to = $('#mailTo').value.trim();
  const bad = [
    setErr('errUser', 'smtpUser', !user ? 'Enter your email address.' : !EMAIL_RE.test(user) ? 'That does not look like an email address. Use the form name@gmail.com.' : ''),
    setErr('errPass', 'smtpPass', !pass && !S.snap.settings.hasSmtpPass ? 'Enter the app password. Open “How do I get the app password?” below for the steps.' : ''),
    setErr('errTo', 'mailTo', to && !EMAIL_RE.test(to) ? 'That does not look like an email address. Use the form name@gmail.com, or leave it empty.' : ''),
  ].filter(Boolean);
  if (bad.length) { bad[0].closest('details')?.setAttribute('open', ''); bad[0].focus(); }
  return !bad.length;
}
async function saveSettings() {
  if (!validateSettings()) { $('#settingsMsg').textContent = 'Fix the fields marked in red, then try again.'; return false; }
  const body = { mailTo: $('#mailTo').value, smtpUser: $('#smtpUser').value, smtpPass: $('#smtpPass').value, smtpHost: $('#smtpHost').value, smtpPort: $('#smtpPort').value, timezone: $('#tz').value };
  try { await api('/api/settings', body); } catch (e) { $('#settingsMsg').textContent = e.message; return false; }
  $('#smtpPass').value = ''; S.settingsFilled = false; S.wavesKey = ''; await refresh();
  $('#settingsMsg').textContent = 'Saved.'; return true;
}

/* ---------------- polling ---------------- */
async function refresh() {
  try {
    const snap = await api('/api/state'); S.snap = snap;
    if (!S.loaded) {
      S.plan = snap.plan.items; S.profile = snap.profile;
      S.going = new Set(snap.myEvents?.going || []); S.custom = snap.myEvents?.custom || []; S.parties = snap.parties || null;
      const ui = snap.ui || {}; // put the screen back the way it was left
      S.filters = ui.filters || {}; S.q = ui.q || ''; S.terms = S.q ? parseQuery(S.q) : [];
      S.sort = ui.sort || 'match'; S.limit = ui.limit || 80; S.showAll = new Set(ui.showAll || []); S.fq = ui.fq || {};
      S.open = ui.tab ? new Set(ui.open || []) : null; S.pendingScroll = ui.scrollY > 0 ? ui.scrollY : null;
      S.dismissed = new Set(snap.dismissed || []); S.showDismissed = ui.showDismissed === true;
      S.groupRepeats = ui.groupRepeats !== false; $('#groupRepeats').checked = S.groupRepeats; S.showPartial = ui.showPartial === true;
      $('#askInput').value = S.q; $('#sort').value = S.sort;
      S.loaded = true; renderTags();
      if (ui.tab && ui.tab !== 'sessions' && !location.hash.slice(1)) showTab(ui.tab);
    }
    fillSettings();
    if (snap.catalog && snap.catalog.fetchedAt !== S.stamp) await loadCatalog();
    else if (!snap.catalog && !S.facets.length) rebuildFacets();
    else if (snap.event && !S.sessions.length && !S.facets.some(g => g.key === 'day')) rebuildFacets();
    $('#catInfo').textContent = snap.catalog ? `${snap.catalog.count} sessions (catalog total ${snap.catalog.totalCount ?? 'unknown'}). Last synced ${new Date(snap.catalog.fetchedAt).toLocaleString()}.` : 'Not loaded yet.';
    renderHeader(); renderBanner(); renderBook();
  } catch (e) { $('#banner').innerHTML = `<div class="banner bad"><b>Cannot reach the app.</b> Is the window still open? ${esc(e.message)}</div>`; }
}

/* ---------------- events ---------------- */
$$('nav.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) { for (const n of ['sessions', 'calendar', 'book', 'profile']) { $('#tab-' + n).hidden = n !== t; $('#t-' + n).setAttribute('aria-selected', n === t); } if (t === 'book') { S.wavesKey = ''; renderBook(); tickCountdown(); } if (t === 'calendar') cal?.render(); saveUi(); }
$('#goBook').onclick = () => showTab('book');
$('#goCal').onclick = () => showTab('calendar');
$('#clearAll').onclick = () => { S.filters = {}; S.fq = {}; S.q = ''; S.terms = []; S.limit = 80; $('#askInput').value = ''; renderFilters(); renderResults(); saveUi(); };
$('#sort').onchange = e => { S.sort = e.target.value; renderResults(); saveUi(); };
$('#more').onclick = () => { S.limit += 80; renderResults(); saveUi(); };
$('#showPartial').onchange = e => { S.showPartial = e.target.checked; S.limit = 80; renderResults(); saveUi(); };
$('#groupRepeats').onchange = e => { S.groupRepeats = e.target.checked; S.limit = 80; renderResults(); saveUi(); };
$('#showDismissed').onchange = e => { S.showDismissed = e.target.checked; updateCounts(); renderResults(); saveUi(); };
$('#restoreAll').onclick = () => { const ids = [...S.dismissed]; setDismissed(ids, false); toast(`Brought back ${ids.length} hidden session${ids.length === 1 ? '' : 's'}.`, () => setDismissed(ids, true)); };
window.addEventListener('scroll', saveUi, { passive: true });
$('#askForm').onsubmit = async e => {
  e.preventDefault();
  S.q = $('#askInput').value.trim(); S.limit = 80;
  S.terms = parseQuery(S.q); if (S.q && S.sort !== 'match') { S.sort = 'match'; $('#sort').value = 'match'; }
  if (S.q && !S.terms.length) toast('Those words are too general to search on. Try a service, topic or technology, for example "Lambda" or "agents".');
  renderResults(); saveUi();
};
$('#favBtn').onclick = async () => {
  const ids = S.plan.map(p => p.sessionId), msg = $('#favMsg');
  if (!ids.length) { msg.textContent = 'Add sessions to your plan first.'; return; }
  msg.textContent = 'Saving…';
  try { const r = await api('/api/favorites', { sessionIds: ids }); msg.textContent = `Added ${r.added} to Favorites${r.failed ? `, ${r.failed} failed` : ''}. Already-favorited sessions are skipped.`; } catch (e) { msg.textContent = e.message; }
};
const startRun = async mode => { try { await api('/api/book/start', { mode }); S.logLen = -1; refresh(); } catch (e) { alert(e.message); } };
$('#practiceBtn').onclick = () => startRun('rehearse');
$('#liveBtn').onclick = () => { if (confirm('This will book real seats as soon as booking opens, and it keeps trying until it is done. Keep this window open. Start?')) startRun('live'); };
$('#stopBtn').onclick = async () => { await api('/api/book/stop', {}); refresh(); };
$('#saveWaves').onclick = async () => {
  const iso = $$('[data-wave]').map(i => ptInputToIso(i.value)).filter(Boolean);
  if (!iso.length) return; await api('/api/settings', { waves: iso }); S.wavesKey = ''; document.activeElement?.blur(); refresh();
};
$('#resetWaves').onclick = async () => { await api('/api/settings', { waves: S.snap.settings.defaultWaves }); S.wavesKey = ''; refresh(); };
$$('.add').forEach(f => f.onsubmit = e => { e.preventDefault(); const i = f.querySelector('input'), v = i.value.trim().toLowerCase(); if (v && !S.profile[f.dataset.list].includes(v)) S.profile[f.dataset.list].push(v); i.value = ''; saveProfile(); });
$('#saveSettings').onclick = () => saveSettings();
$('#testMail').onclick = async () => {
  if (!(await saveSettings())) return;
  $('#settingsMsg').textContent = 'Sending a test email…';
  try { await api('/api/email/test', {}); $('#settingsMsg').textContent = `Sent. Check the inbox of ${S.snap.settings.sendsTo} (and the spam folder).`; } catch (e) { $('#settingsMsg').textContent = e.message; }
};
$('#resync').onclick = startSync;
$('#signout').onclick = async () => { await api('/api/logout', {}); S.sessions = []; S.stamp = null; refresh(); };

cal = initCalendar({ S, api, $, $$, esc, TIERS, setTier, toast, when, placeOf, placeHtml });
refresh(); setInterval(refresh, 2000); setInterval(tickCountdown, 1000);
const startTab = location.hash.slice(1); if (['calendar', 'book', 'profile'].includes(startTab)) showTab(startTab);
