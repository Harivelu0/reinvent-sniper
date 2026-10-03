import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PORTS, EVENT_ID, DEFAULT_WAVES } from './src/config.js';
import { buildAuthUrl, completeSignIn, authStatus, signOut, AuthRequiredError } from './src/auth.js';
import { EventsClient, ApiError } from './src/api.js';
import { syncCatalog, loadCatalog } from './src/catalog.js';
import { Booker } from './src/booker.js';
import { sendMail, mailConfigured, mailRecipient, reportEmail } from './src/notify.js';
import { getSettings, saveSettings, getPlan, savePlan, getProfile, saveProfile, getUi, saveUi, getRun, saveRun, getDismissed, saveDismissed, getMyEvents, saveMyEvents } from './src/store.js';
import { fetchParties, getParties } from './src/parties.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const client = new EventsClient();
let catalog = loadCatalog();
let eventInfo = catalog?.event || null;
let sync = { running: false, fetched: 0, total: null, error: null, doneAt: null };
let port = null;
// Bump when the page starts needing something new from the server. The page compares this and tells you to restart if they differ.
const BUILD = 7;

const booker = new Booker({
  client, getPlan, getCatalog: () => catalog, getSettings,
  notify: (subject, html, text) => sendMail(getSettings(), subject, html, text),
  persist: saveRun,
});
const restored = booker.restore(getRun()); // pick up a live watch that was interrupted by a crash or restart

const refreshEvent = () => client.getEvent().then(e => { eventInfo = e; }).catch(() => {});

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (res, e) => {
  if (e instanceof AuthRequiredError) return send(res, 401, { error: e.message, needSignIn: true });
  const code = e instanceof ApiError ? (e.status === 403 ? 403 : 502) : 500;
  send(res, code, { error: e.message || String(e) });
};
const readJson = req => new Promise((resolve, reject) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) { reject(new Error('Request too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('Bad JSON')); } });
});

// This server can make reservations, so only the page it serves may call it (blocks other websites and DNS rebinding).
function allowed(req) {
  const host = req.headers.host;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return false;
  if (req.method !== 'GET') {
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
    if (req.headers['x-sniper'] !== '1') return false;
  }
  return true;
}

function publicSettings() {
  const s = getSettings();
  return {
    mailTo: s.mailTo, sendsTo: mailRecipient(s), smtpHost: s.smtpHost, smtpPort: s.smtpPort, smtpUser: s.smtpUser, hasSmtpPass: Boolean(s.smtpPass),
    timezone: s.timezone, waves: s.waves?.length ? s.waves : DEFAULT_WAVES, defaultWaves: DEFAULT_WAVES,
    mailReady: mailConfigured(s),
  };
}

function snapshot() {
  const b = booker.state;
  return {
    build: BUILD, now: Date.now(), port, eventId: EVENT_ID, event: eventInfo, auth: authStatus(), sync,
    catalog: catalog ? { fetchedAt: catalog.fetchedAt, count: catalog.count, totalCount: catalog.totalCount, warnings: catalog.warnings } : null,
    plan: getPlan(), profile: getProfile(), ui: getUi(), dismissed: getDismissed(), settings: publicSettings(),
    parties: getParties(), myEvents: getMyEvents(),
    booking: { ...b, log: b.log.slice(-250) },
  };
}

async function runSync() {
  if (sync.running) return;
  sync = { running: true, fetched: 0, total: null, error: null, doneAt: null };
  try {
    catalog = await syncCatalog(client, p => { sync.fetched = p.fetched; sync.total = p.total; });
    eventInfo = catalog.event || eventInfo;
    sync.doneAt = Date.now();
  } catch (e) { sync.error = e.message; }
  sync.running = false;
}

/* ---------- routes ---------- */
const routes = {
  'GET /api/state': async (req, res) => send(res, 200, snapshot()),
  'GET /api/catalog': async (req, res) => send(res, 200, catalog ? { fetchedAt: catalog.fetchedAt, event: eventInfo, sessions: catalog.sessions } : { sessions: [], event: eventInfo }),
  'POST /api/sync': async (req, res) => { runSync(); send(res, 202, { started: true }); },
  'POST /api/logout': async (req, res) => { booker.stop(); signOut(); send(res, 200, { ok: true }); },
  'POST /api/plan': async (req, res) => {
    const { items } = await readJson(req);
    const clean = (Array.isArray(items) ? items : []).filter(i => i && typeof i.sessionId === 'string' && ['Must-have', 'Nice-to-have', 'Backup'].includes(i.tier)).map(i => ({ sessionId: i.sessionId, tier: i.tier }));
    savePlan({ items: clean }); send(res, 200, { ok: true });
  },
  // The party list is third-party content: it is fetched from the site only when the person presses the button, and kept on this computer.
  'POST /api/parties/sync': async (req, res) => { const p = await fetchParties(); send(res, 200, { count: p.events.length, fetchedAt: p.fetchedAt }); },
  'POST /api/events': async (req, res) => {
    const b = await readJson(req);
    const going = [...new Set((Array.isArray(b.going) ? b.going : []).map(String))].slice(0, 500);
    const str = (v, n) => String(v ?? '').slice(0, n).trim();
    const custom = (Array.isArray(b.custom) ? b.custom : []).slice(0, 200).map(c => ({
      id: str(c.id, 40), title: str(c.title, 120), date: str(c.date, 10), start: Math.round(Number(c.start)), end: Math.round(Number(c.end)),
      place: str(c.place, 200), note: str(c.note, 500),
    })).filter(c => c.id && c.title && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.start >= 0 && c.start < 1440 && c.end > c.start && c.end <= 2880);
    saveMyEvents({ going, custom }); send(res, 200, { ok: true });
  },
  'POST /api/dismissed': async (req, res) => {
    const { ids } = await readJson(req);
    saveDismissed([...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20000)); send(res, 200, { ok: true });
  },
  'POST /api/ui': async (req, res) => {
    const b = await readJson(req);
    const strs = a => (Array.isArray(a) ? a : []).map(String).slice(0, 200);
    const filters = {};
    for (const [k, v] of Object.entries(b.filters && typeof b.filters === 'object' ? b.filters : {})) if (Array.isArray(v) && v.length) filters[String(k).slice(0, 60)] = strs(v);
    saveUi({
      tab: ['sessions', 'calendar', 'book', 'profile'].includes(b.tab) ? b.tab : 'sessions', filters,
      q: String(b.q || '').slice(0, 300), sort: ['match', 'time', 'seats'].includes(b.sort) ? b.sort : 'match',
      limit: Math.min(Math.max(Number(b.limit) || 80, 80), 3000), open: strs(b.open), showAll: strs(b.showAll), fq: Object.fromEntries(Object.entries(b.fq || {}).slice(0, 40).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 80)])),
      scrollY: Math.max(0, Math.min(Number(b.scrollY) || 0, 1e6)), mode: b.mode === 'live' ? 'live' : 'rehearse', showDismissed: b.showDismissed === true, groupRepeats: b.groupRepeats !== false, showPartial: b.showPartial === true,
    });
    send(res, 200, { ok: true });
  },
  'POST /api/profile': async (req, res) => {
    const b = await readJson(req); const list = a => (Array.isArray(a) ? a : []).map(x => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 50);
    saveProfile({ likes: list(b.likes), skips: list(b.skips) }); send(res, 200, { ok: true });
  },
  'POST /api/settings': async (req, res) => {
    const b = await readJson(req); const cur = getSettings(); const next = { ...cur };
    for (const k of ['mailTo', 'smtpHost', 'smtpUser', 'timezone']) if (typeof b[k] === 'string') next[k] = b[k].trim();
    if (b.smtpPort) next.smtpPort = Number(b.smtpPort) || cur.smtpPort;
    // Google shows app passwords as four groups of four letters. The spaces are not part of the password.
    if (typeof b.smtpPass === 'string' && b.smtpPass.trim()) next.smtpPass = b.smtpPass.replace(/\s+/g, '');       // blank keeps the saved password
    const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (next.smtpUser && !EMAIL.test(next.smtpUser)) return send(res, 400, { error: 'Your email address does not look right. Use the form name@gmail.com.' });
    if (next.mailTo && !EMAIL.test(next.mailTo)) return send(res, 400, { error: 'The "send reports to" address does not look right. Use the form name@gmail.com, or leave it empty to use your own address.' });
    if (Array.isArray(b.waves)) next.waves = b.waves.filter(w => Number.isFinite(Date.parse(w))).map(w => new Date(w).toISOString());
    saveSettings(next); send(res, 200, publicSettings());
  },
  'POST /api/email/test': async (req, res) => {
    const { html, text } = reportEmail({ heading: 'Reinvent Sniper test email', rows: [], footer: 'If you can read this, booking reports will reach you.' });
    const r = await sendMail(getSettings(), 'Reinvent Sniper test email', html, text);
    send(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
  },
  'POST /api/favorites': async (req, res) => {
    const { sessionIds } = await readJson(req); const ids = [...new Set(Array.isArray(sessionIds) ? sessionIds : [])];
    let ok = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 10) {
      const r = await client.favorite(ids.slice(i, i + 10));
      ok += r.successful.length; failed += r.failed.filter(f => f.code !== 'alreadyFavorited').length;
    }
    send(res, 200, { added: ok, failed });
  },
  'POST /api/book/start': async (req, res) => { const { mode } = await readJson(req); await booker.start({ mode: mode === 'live' ? 'live' : 'rehearse' }); send(res, 200, { ok: true }); },
  'POST /api/book/stop': async (req, res) => { booker.stop(); send(res, 200, { ok: true }); },
  'POST /api/book/swap': async (req, res) => { const { sessionId } = await readJson(req); await booker.swap(String(sessionId)); send(res, 200, { ok: true }); },
};

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(302, { Location: buildAuthUrl(port) }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/callback') {
      const err = url.searchParams.get('error');
      if (err) return send(res, 400, `<p>Sign-in was cancelled or failed: ${url.searchParams.get('error_description') || err}. <a href="/">Back</a></p>`, 'text/html; charset=utf-8');
      try {
        await completeSignIn({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        refreshEvent();
        if (!catalog) runSync();
        res.writeHead(302, { Location: '/' }); return res.end();
      } catch (e) { return send(res, 400, `<p>${String(e.message).replace(/</g, '&lt;')} <a href="/">Back</a></p>`, 'text/html; charset=utf-8'); }
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      try { return await handler(req, res); } catch (e) { return fail(res, e); }
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(ROOT, 'web', rel);
      if (file.startsWith(path.join(ROOT, 'web')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { fail(res, e); }
});

function listen(i = 0) {
  if (i >= PORTS.length) { console.error('Ports 8484-8489 are all in use. Close another copy of this app and try again.'); process.exit(1); }
  // Exactly one of these two handlers runs per attempt, and each removes the other. Passing a callback to listen()
  // would leave the failed attempt's callback registered, and it would announce the busy port as well as the working one.
  const onError = e => { server.off('listening', onListening); if (e.code === 'EADDRINUSE') listen(i + 1); else throw e; };
  const onListening = () => {
    server.off('error', onError);
    port = PORTS[i];
    const url = `http://localhost:${port}`;
    console.log(`\nReinvent Sniper is running at ${url}\nKeep this window open. Press Ctrl+C to quit.\n`);
    refreshEvent();
    if (restored.resume) {
      console.log('A live watch was running when the app last closed. Resuming it.');
      booker.start({ mode: 'live', resumed: true }).catch(e => console.error('Could not resume the watch:', e.message));
    }
    if (!process.env.NO_BROWSER) {
      // Opening the browser is a convenience. If it fails, the link above still works, and the server must keep running.
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      try { exec(cmd, () => {}).on('error', () => console.log(`Could not open a browser automatically. Open ${url} yourself.`)); }
      catch { console.log(`Could not open a browser automatically. Open ${url} yourself.`); }
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(PORTS[i], '127.0.0.1');
}
listen();
// Closing the app on purpose (Ctrl+C, closing the window) stops the watch for good. A crash or power cut does not, so it resumes.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { booker.stop(); process.exit(0); });
// A booking run can last days. One unexpected error must be loud, but it must not silently end the process.
process.on('uncaughtException', e => console.error('Unexpected error (the app is still running):', e));
process.on('unhandledRejection', e => console.error('Unexpected error (the app is still running):', e));
