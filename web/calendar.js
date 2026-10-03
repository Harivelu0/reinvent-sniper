import { layoutDay, daysBetween, dayLabel } from './shared.js';
import { icon, iconButton } from './icons.js';

const HOUR = 48; // pixels per hour on the grid
const clock = m => { const x = ((m % 1440) + 1440) % 1440, h = Math.floor(x / 60); return `${((h + 11) % 12) + 1}:${String(x % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const span = (a, b) => `${clock(a)} to ${clock(b)}${b > 1440 ? ' (next day)' : ''}`;
const hits = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end;
const pad2 = n => String(n).padStart(2, '0');
const timeValue = m => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
const minutesOf = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };

/**
 * The Calendar tab: your selected sessions, the parties you are going to and your own entries, one column per day.
 * `ctx` supplies the page's shared state and helpers so this file holds only calendar logic.
 *
 * Redraw rule: only what actually changed is redrawn. Ticking a party updates its own row and the grid, never the whole
 * party list (that reset its scroll position) and never the add-entry form (that wiped what was being typed).
 */
export function initCalendar(ctx) {
  const { S, api, $, $$, esc, TIERS, setTier, toast, when, placeOf } = ctx;
  let selected = null, editing = null, filter = '', busy = false, message = '';
  const root = () => $('#tab-calendar');
  const visible = () => root() && !root().hidden;

  /* ---------- gathering what goes on the grid ---------- */
  function items() {
    const timed = [], untimed = [];
    for (const p of S.plan) {
      const s = S.byId.get(p.sessionId); if (!s) continue;
      const base = { id: 's:' + s.sessionId, kind: 'session', tier: p.tier, title: s.title, code: s.code, ref: s };
      if (!s.date || s.startMin == null) { untimed.push({ ...base, note: 'Time not announced yet' }); continue; }
      const start = s.startMin % 1440;
      timed.push({ ...base, date: s.date, start, end: start + Math.max(30, s.endMin - s.startMin), place: placeOf(s) });
    }
    for (const e of S.parties?.events || []) {
      if (!S.going.has(e.id)) continue;
      const base = { id: e.id, kind: 'party', title: e.name, ref: e, host: e.sponsor };
      if (e.start == null) { untimed.push({ ...base, note: 'Time not listed' }); continue; }
      timed.push({ ...base, date: e.date, start: e.start, end: e.end, place: { venue: e.venue, where: e.place.replace(e.venue, '').replace(/^,\s*/, '') } });
    }
    for (const c of S.custom) timed.push({ id: c.id, kind: 'mine', title: c.title, date: c.date, start: c.start, end: c.end, place: { venue: c.place, where: '' }, ref: c });
    // A clash is a Must-have or Nice-to-have overlapping another one, or a party or your own entry overlapping a session you plan to attend.
    const attend = timed.filter(x => x.kind === 'session' && x.tier !== 'Backup');
    for (const a of timed) {
      a.clashes = [];
      for (const b of attend) {
        if (a === b || !hits(a, b)) continue;
        if (a.kind === 'session' && a.tier === 'Backup') continue; // backups overlap on purpose
        a.clashes.push(b.code || b.title);
      }
    }
    return { timed, untimed };
  }
  /** Sessions you plan to attend that a party overlaps, so a party can show its warning before you tick it. */
  const clashNames = (e, timed) => (e.start == null ? [] : [...new Set(timed.filter(s => s.kind === 'session' && s.tier !== 'Backup' && s.date === e.date && e.start < s.end && s.start < e.end).map(s => s.code))]);
  const eventDays = () => (S.snap?.event ? daysBetween(S.snap.event.startDate, S.snap.event.endDate) : []);
  const formDays = () => { const ed = eventDays(); return ed.length ? [new Date(Date.parse(ed[0] + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10), ...ed] : []; };

  /* ---------- grid ---------- */
  function gridHtml(timed) {
    const days = [...new Set([...eventDays(), ...timed.map(t => t.date)])].sort();
    if (!days.length) return '<div class="empty">Sign in to load the event days.</div>';
    const first = Math.min(7 * 60, ...timed.map(t => Math.floor(t.start / 60) * 60)), last = 24 * 60;
    const rows = (last - first) / 60, height = rows * HOUR;
    const hours = Array.from({ length: rows }, (_, i) => `<div class="calh" style="top:${i * HOUR}px">${clock(first + i * 60).replace(':00', '')}</div>`).join('');
    const cols = days.map(d => {
      const placed = layoutDay(timed.filter(t => t.date === d).map(t => ({ ...t })));
      const blocks = placed.map(t => {
        const top = (Math.max(t.start, first) - first) / 60 * HOUR, bottom = (Math.min(t.end, last) - first) / 60 * HOUR;
        const h = Math.max(22, bottom - top - 2);
        const cls = `blk ${t.kind} ${t.kind === 'session' ? (t.tier === 'Must-have' ? 'must' : t.tier === 'Nice-to-have' ? 'nice' : 'backup') : ''} ${t.clashes.length ? 'clash' : ''} ${selected === t.id ? 'sel' : ''}`;
        const venue = t.place?.venue ? esc(t.place.venue) : '';
        const label = t.kind === 'party' ? 'Party · ' : t.kind === 'mine' ? 'Mine · ' : t.tier === 'Backup' ? 'Backup · ' : '';
        return `<button class="${cls}" data-item="${esc(t.id)}" style="top:${top}px;height:${h}px;left:calc(${t.lane / t.lanes * 100}% + 1px);width:calc(${100 / t.lanes}% - 3px)" title="${esc(t.title)}">
          ${h < 40
            ? `<span class="bn one">${esc(clock(t.start))} · ${esc(t.title)}</span>`
            : `<span class="bt">${label}${esc(clock(t.start))}</span><span class="bn">${esc(t.title)}</span>${h > 54 && venue ? `<span class="bp">${venue}</span>` : ''}`}</button>`;
      }).join('');
      return `<div class="calcol"><div class="calhead">${esc(dayLabel(d))}</div><div class="calbody" style="height:${height}px">${blocks}</div></div>`;
    }).join('');
    return `<div class="calgrid" style="--cols:${days.length}"><div class="calcol timecol"><div class="calhead">&nbsp;</div><div class="calbody" style="height:${height}px">${hours}</div></div>${cols}</div>`;
  }

  /* ---------- detail panel (sits above the grid, so choosing a block never scrolls the page) ---------- */
  function detailHtml(all) {
    const it = all.find(x => x.id === selected);
    if (!it) return '<p class="hint">Click a block to read about it. Click a session to change its tier, or a party to open its RSVP link.</p>';
    const clash = it.clashes?.length ? `<div class="clash">Overlaps ${esc([...new Set(it.clashes)].join(', '))}</div>` : '';
    const close = iconButton('x', 'Close', 'data-cal-close');
    if (it.kind === 'session') {
      const s = it.ref;
      return `<div class="rowsb"><h3>${esc(s.code)} · ${esc(s.title)}</h3>${close}</div><div class="dmeta">${esc(when(s))}</div><div class="placeline">${ctx.placeHtml(s)}</div>${clash}
        <div class="rowwrap" style="margin-top:8px"><label class="tiersel">Tier <select data-cal-tier="${esc(s.sessionId)}">${TIERS.map(t => `<option ${t === it.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button class="btn ghost" data-cal-remove="${esc(s.sessionId)}" title="Remove from plan">${icon('trash')}Remove from plan</button></div>
        ${s.abstract ? `<details class="abs"><summary>Abstract</summary><p>${esc(s.abstract)}</p></details>` : ''}`;
    }
    if (it.kind === 'party') {
      const e = it.ref;
      return `<div class="rowsb"><h3>${esc(e.name)}</h3>${close}</div><div class="dmeta">Hosted by ${esc(e.sponsor)} · ${esc(e.timeText)}${e.timeNote ? ' · ' + esc(e.timeNote) : ''}${e.endGuessed ? ' (end time is a guess)' : ''}</div>
        <div class="placeline"><span class="where">${esc(e.place)}</span></div>${e.status ? `<div class="clash">${esc(e.status)}</div>` : ''}${clash}
        <div class="rowwrap" style="margin-top:8px">${e.rsvpUrl ? `<a class="btn primary" href="${esc(e.rsvpUrl)}" target="_blank" rel="noopener noreferrer">${e.inviteRequired ? 'Request an invite' : 'Open details'}</a>` : ''}
        <button class="btn ghost" data-cal-leave="${esc(e.id)}" title="Take this party off your calendar">${icon('minus')}Not going</button></div>
        <p class="hint">Listing from conferenceparties.com, an unofficial list. Check the host's page for current details.</p>`;
    }
    const c = it.ref;
    return `<div class="rowsb"><h3>${esc(c.title)}</h3>${close}</div><div class="dmeta">${esc(span(c.start, c.end))}</div>${c.place ? `<div class="placeline"><span class="where">${esc(c.place)}</span></div>` : ''}${c.note ? `<p>${esc(c.note)}</p>` : ''}${clash}
      <div class="rowwrap" style="margin-top:8px"><button class="btn" data-cal-edit="${esc(c.id)}" title="Edit this entry">${icon('pencil')}Edit</button><button class="btn ghost danger" data-cal-delete="${esc(c.id)}" title="Delete this entry">${icon('trash')}Delete</button></div>`;
  }

  /* ---------- parties list and the add form ---------- */
  function partiesHtml(timed) {
    const p = S.parties;
    const head = p
      ? `<p class="hint">${p.events.length} parties, read from <a href="${esc(p.source.url)}" target="_blank" rel="noopener noreferrer">${esc(p.source.name)}</a> (an unofficial community list) on ${esc(new Date(p.fetchedAt).toLocaleString())}. Tick the ones you are going to and they appear on the calendar.</p>`
      : '<p class="hint">Load the community list of re:Invent parties from conferenceparties.com, then tick the ones you are going to. Nothing is added to the calendar until you tick it.</p>';
    const btn = `<button class="btn ${p ? '' : 'primary'}" id="calLoad" ${busy ? 'disabled' : ''}>${busy ? 'Loading…' : p ? 'Refresh the list' : 'Load parties from conferenceparties.com'}</button>`;
    if (!p) return `<div class="rowwrap">${btn}</div><p class="hint" id="calMsg">${esc(message)}</p>`;
    const f = filter.toLowerCase();
    const list = p.events.filter(e => !f || `${e.name} ${e.sponsor} ${e.place}`.toLowerCase().includes(f));
    const byDay = new Map(); list.forEach(e => (byDay.get(e.date) || byDay.set(e.date, []).get(e.date)).push(e));
    const rows = [...byDay].sort().map(([d, evs]) => `<div class="pday">${esc(dayLabel(d))}</div>` + evs.map(e => {
      const c = clashNames(e, timed);
      return `<label class="prow ${S.going.has(e.id) ? 'on' : ''}"><input type="checkbox" data-going="${esc(e.id)}" ${S.going.has(e.id) ? 'checked' : ''}>
        <span class="ptime">${esc(e.timeText)}</span><span class="pmain"><b>${esc(e.name)}</b><span class="where">${esc(e.sponsor)} · ${esc(e.place)}</span>
        ${e.status ? `<span class="missing">${esc(e.status)}</span>` : ''}${c.length ? `<span class="missing clashnote">Overlaps ${esc(c.join(', '))}</span>` : ''}</span>
        ${e.rsvpUrl ? `<a class="btn small" href="${esc(e.rsvpUrl)}" target="_blank" rel="noopener noreferrer" title="${e.inviteRequired ? 'Open the page to request an invite' : 'Open the party page'} (opens in a new tab)">${e.inviteRequired ? 'Invite' : 'Details'}${icon('external', 13)}</a>` : ''}</label>`;
    }).join('')).join('');
    return `<div class="rowwrap">${btn}<input id="calFilter" type="search" placeholder="Search parties" aria-label="Search parties" value="${esc(filter)}"></div>${head}<p class="hint" id="calMsg">${esc(message)}</p><div class="plist">${rows || '<div class="empty">No parties match.</div>'}</div>`;
  }

  function formHtml(days) {
    const c = S.custom.find(x => x.id === editing) || { title: '', date: days[1] || days[0] || '', start: 19 * 60, end: 21 * 60, place: '', note: '' };
    return `<form id="calForm" class="calform"><h3>${editing ? 'Edit your entry' : 'Add your own entry'}</h3>
      <label>What<input id="cfTitle" type="text" maxlength="120" required value="${esc(c.title)}" placeholder="Dinner with the team"></label>
      <div class="two3"><label>Day<select id="cfDate">${days.map(d => `<option value="${esc(d)}" ${d === c.date ? 'selected' : ''}>${esc(dayLabel(d))}</option>`).join('')}</select></label>
      <label>From<input id="cfStart" type="time" required value="${timeValue(c.start)}"></label><label>To<input id="cfEnd" type="time" required value="${timeValue(c.end % 1440)}"></label></div>
      <label>Where<input id="cfPlace" type="text" maxlength="200" value="${esc(c.place)}" placeholder="Optional"></label>
      <label>Note<input id="cfNote" type="text" maxlength="500" value="${esc(c.note)}" placeholder="Optional"></label>
      <div class="rowwrap"><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add to calendar'}</button>${editing ? '<button class="btn" type="button" id="cfCancel">Cancel</button>' : ''}<span class="hint" id="cfMsg"></span></div></form>`;
  }

  /* ---------- saving ---------- */
  let saveTimer;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/api/events', { going: [...S.going], custom: S.custom }).catch(() => {}), 300); };

  /* ---------- drawing, one piece at a time ---------- */
  function renderGrid(timed, untimed, all) {
    const clashes = timed.filter(t => t.clashes.length).length;
    $('#calSummary').innerHTML = `${timed.filter(t => t.kind === 'session').length} sessions · ${timed.filter(t => t.kind === 'party').length} parties · ${timed.filter(t => t.kind === 'mine').length} of your own`
      + (clashes ? ` · <span class="missing">${clashes} overlap${clashes > 1 ? 's' : ''}</span>` : '') + ' · all times are Las Vegas time';
    $('#calGrid').innerHTML = gridHtml(timed);
    $('#calUntimed').innerHTML = untimed.length ? `<div class="hint"><b>Not on the grid yet:</b> ${untimed.map(u => `<button class="linkbtn" data-item="${esc(u.id)}">${esc(u.title)}</button> (${esc(u.note)})`).join(' · ')}</div>` : '';
    const d = $('#calDetail'); d.innerHTML = detailHtml(all); d.classList.toggle('on', all.some(x => x.id === selected));
    bindGrid();
  }

  /** Redraws the party list while keeping its scroll position and keyboard focus. Used only when the list's content changes. */
  let partiesKey = null; // which version of the list is on screen, so it is redrawn when new data arrives and only then
  const keyOfParties = () => (S.parties ? S.parties.fetchedAt : 'none');
  function renderParties() {
    partiesKey = keyOfParties();
    const box = $('#calParties'), old = box.querySelector('.plist');
    const top = old ? old.scrollTop : 0, focusId = document.activeElement?.dataset?.going;
    box.innerHTML = partiesHtml(items().timed);
    const fresh = box.querySelector('.plist'); if (fresh) fresh.scrollTop = top;
    if (focusId) box.querySelector(`[data-going="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    bindParties();
  }

  /** After a tick or a plan change: update each row's highlight and overlap warning in place, without redrawing the list. */
  function updateRowFlags(timed) {
    if (!S.parties) return;
    const byId = new Map(S.parties.events.map(e => [e.id, e]));
    $$('#calParties .prow').forEach(row => {
      const id = row.querySelector('[data-going]').dataset.going, e = byId.get(id); if (!e) return;
      row.classList.toggle('on', S.going.has(id));
      row.querySelector('[data-going]').checked = S.going.has(id); // "Not going" in the details panel must untick the box too
      const c = clashNames(e, timed), note = row.querySelector('.clashnote');
      if (c.length) {
        const text = 'Overlaps ' + c.join(', ');
        if (note) note.textContent = text;
        else { const sp = document.createElement('span'); sp.className = 'missing clashnote'; sp.textContent = text; row.querySelector('.pmain').appendChild(sp); }
      } else note?.remove();
    });
  }

  function render() {
    if (!visible()) return;
    const { timed, untimed } = items();
    renderGrid(timed, untimed, [...timed, ...untimed]);
    if (!root().dataset.built) {
      renderParties(); $('#calAdd').innerHTML = formHtml(formDays()); bindForm(); root().dataset.built = '1';
    } else {
      if (partiesKey !== keyOfParties()) renderParties(); // the list arrived or was refreshed since the last draw
      updateRowFlags(timed);
      // The event days can arrive after the first draw. Fill the day list then, but never while the form is being used.
      const sel = $('#cfDate'), idle = !document.activeElement?.closest('#calAdd');
      if (sel && idle && sel.options.length !== formDays().length) { $('#calAdd').innerHTML = formHtml(formDays()); bindForm(); }
    }
  }

  /* ---------- wiring ---------- */
  function bindGrid() {
    $$('#tab-calendar [data-item]').forEach(b => b.onclick = () => { selected = b.dataset.item; render(); });
    $$('#calDetail [data-cal-close]').forEach(b => b.onclick = () => { selected = null; render(); });
    $$('#calDetail [data-cal-tier]').forEach(s => s.onchange = () => setTier(s.dataset.calTier, s.value));
    $$('#calDetail [data-cal-remove]').forEach(b => b.onclick = () => { selected = null; setTier(b.dataset.calRemove, null); });
    $$('#calDetail [data-cal-leave]').forEach(b => b.onclick = () => { S.going.delete(b.dataset.calLeave); selected = null; saveSoon(); render(); });
    $$('#calDetail [data-cal-edit]').forEach(b => b.onclick = () => { editing = b.dataset.calEdit; $('#calAdd').innerHTML = formHtml(formDays()); bindForm(); $('#calAdd').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    $$('#calDetail [data-cal-delete]').forEach(b => b.onclick = () => {
      const id = b.dataset.calDelete, gone = S.custom.find(x => x.id === id);
      S.custom = S.custom.filter(x => x.id !== id); selected = null; saveSoon(); render();
      toast(`Deleted “${gone?.title}”.`, () => { S.custom.push(gone); saveSoon(); render(); });
    });
  }

  function bindParties() {
    const load = $('#calLoad'); if (load) load.onclick = async () => {
      busy = true; message = ''; renderParties();
      try { const r = await api('/api/parties/sync', {}); S.parties = (await api('/api/state')).parties; message = `Loaded ${r.count} parties.`; }
      catch (e) { message = e.message; }
      busy = false; renderParties(); render();
    };
    const cf = $('#calFilter'); if (cf) cf.oninput = e => {
      filter = e.target.value; const pos = e.target.selectionStart;
      renderParties(); const f = $('#calFilter'); f.focus(); f.setSelectionRange(pos, pos);
    };
    // Ticking changes only this row, the grid and the summary. The list is not redrawn, so it stays exactly where it is.
    $$('#calParties [data-going]').forEach(c => c.onchange = () => {
      c.checked ? S.going.add(c.dataset.going) : S.going.delete(c.dataset.going);
      saveSoon(); render();
    });
  }

  function bindForm() {
    const cancel = $('#cfCancel'); if (cancel) cancel.onclick = () => { editing = null; $('#calAdd').innerHTML = formHtml(formDays()); bindForm(); };
    const f = $('#calForm'); if (!f) return;
    f.onsubmit = e => {
      e.preventDefault();
      const start = minutesOf($('#cfStart').value); let end = minutesOf($('#cfEnd').value);
      if (start == null || end == null) { $('#cfMsg').textContent = 'Enter a start and end time.'; return; }
      if (end <= start) end += 1440; // ends after midnight
      const rec = { id: editing || 'mine-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: $('#cfTitle').value.trim(), date: $('#cfDate').value, start, end, place: $('#cfPlace').value.trim(), note: $('#cfNote').value.trim() };
      if (!rec.title) { $('#cfMsg').textContent = 'Give it a name.'; return; }
      S.custom = editing ? S.custom.map(c => (c.id === editing ? rec : c)) : [...S.custom, rec];
      selected = rec.id; editing = null; saveSoon(); $('#calAdd').innerHTML = formHtml(formDays()); bindForm(); render();
    };
  }

  return { render };
}
