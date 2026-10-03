// A local stand-in for the AWS Events API and its OAuth server, built from the published OpenAPI spec.
// Used by the tests and by `npm run mock` so the whole app can be tried without a real sign-in.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const EVENT = {
  eventId: 'reinvent2026', name: 're:Invent 2026', eventType: 'AWS Global Summit', isOnline: false, authenticationRequired: true,
  startDate: '2026-11-30T05:30:00.000-08:00', endDate: '2026-12-04T23:59:00.000-08:00', timezone: 'America/Los_Angeles',
};

const TYPES = ['Workshop', 'Chalk talk', 'Breakout session', 'Builder session', 'Lightning talk'];
const LEVELS = ['100 - Foundational', '200 - Intermediate', '300 - Advanced', '400 - Expert'];
const TOPICS = ['Serverless', 'Agentic AI', 'Containers', 'Security', 'Streaming', 'Cost optimization', 'Architecture', 'Media'];
const SERVICES = ['Lambda', 'EventBridge', 'Bedrock', 'ECS', 'MSK', 'DynamoDB', 'IAM', 'Step Functions'];
const DAYS = ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'];

export function makeSessions(n = 120) {
  return Array.from({ length: n }, (_, i) => {
    const day = DAYS[i % 5], hour = 8 + (i * 3) % 9;
    return {
      sessionId: `sess-${String(i + 1).padStart(4, '0')}`,
      abbreviation: `${['SVS', 'AIM', 'CON', 'SEC', 'DAT'][i % 5]}${300 + (i % 100)}`,
      title: `${TOPICS[i % 8]} deep dive ${i + 1} with ${SERVICES[i % 8]}`,
      abstract: `A session about ${TOPICS[i % 8].toLowerCase()} using ${SERVICES[i % 8]}.`,
      type: TYPES[i % 5], level: LEVELS[i % 4], venue: ['Venetian', 'Wynn', 'MGM Grand', 'Caesars Forum'][i % 4], room: `Room ${i % 30}`,
      isReservable: true, seatAvailability: 'available', isAllDaySession: false,
      sessionTime: { date: day, time: `${String(hour).padStart(2, '0')}:00`, length: '60', timezone: 'America/Los_Angeles' },
      speakers: [{ name: `Speaker ${i % 17}` }],
      topics: [TOPICS[i % 8]], services: [SERVICES[i % 8]], tracks: [`Track ${i % 6}`], roles: [['Developer', 'Architect', 'Manager'][i % 3]],
      industries: [], areasOfInterest: [], focusAreas: [], segments: [], features: [], customerPersonas: [], experiences: [], additionalActivities: [],
    };
  });
}

export async function startMock({ port = 0, sessions = makeSessions(), open = true, quotaPerMinute = 30 } = {}) {
  const ctl = {
    open, sessions, capacity: {}, reserved: new Set(), favorites: new Set(), writes: 0, reserveCalls: [],
    failNext: null, // 'apply-then-503' | '503' | 'drop-sessions-from-listing'
    quotaPerMinute, quotaUsed: 0, quotaWindow: Date.now(), pageSizes: [37, 50, 11, 64], hideFromListing: 0,
    codes: new Map(), tokens: new Map(), accessSeq: 0, refreshSeq: 0, expireAccess: false, revokedRefresh: false,
  };
  const byId = () => new Map(ctl.sessions.map(s => [s.sessionId, s]));
  const overlap = (a, b) => {
    const t = s => { const [h, m] = s.sessionTime.time.split(':').map(Number); const st = Date.parse(s.sessionTime.date + 'T00:00:00Z') / 6e4 + h * 60 + m; return [st, st + Number(s.sessionTime.length)]; };
    const [a0, a1] = t(a), [b0, b1] = t(b); return a0 < b1 && b0 < a1;
  };
  const seatsLeft = id => (ctl.capacity[id] ?? Infinity) - [...ctl.reserved].filter(x => x === id).length;
  const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const raw = await readBody(req);
    const body = raw ? (req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};

    /* ---- control ---- */
    if (p === '/__control') { Object.assign(ctl, body.set || {}); if (body.capacity) Object.assign(ctl.capacity, body.capacity); return json(res, 200, { ok: true }); }

    /* ---- oauth ---- */
    if (p === '/oauth2/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      ctl.codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri'), method: url.searchParams.get('code_challenge_method') });
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` }); return res.end();
    }
    if (p === '/oauth2/token') {
      const issue = () => {
        const access = `acc-${++ctl.accessSeq}`, refresh = `ref-${++ctl.refreshSeq}`;
        ctl.tokens.set(access, true); ctl.currentRefresh = refresh;
        const idp = Buffer.from(JSON.stringify({ email: 'tester@example.com' })).toString('base64url');
        return { access_token: access, refresh_token: refresh, id_token: `x.${idp}.y`, expires_in: 3600, token_type: 'Bearer' };
      };
      if (body.grant_type === 'authorization_code') {
        const c = ctl.codes.get(body.code);
        const ok = c && c.method === 'S256' && c.redirect === body.redirect_uri && crypto.createHash('sha256').update(body.code_verifier || '').digest('base64url') === c.challenge;
        return ok ? json(res, 200, issue()) : json(res, 400, { error: 'invalid_grant' });
      }
      if (body.grant_type === 'refresh_token') {
        if (ctl.revokedRefresh || body.refresh_token !== ctl.currentRefresh) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    /* ---- events api ---- */
    const m = /^\/v1\/events\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(res, 404, { message: 'not found' });
    const rest = m[2] || '';
    if (rest === '') return json(res, 200, { event: EVENT });

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth || !ctl.tokens.has(auth) || ctl.expireAccess) { ctl.expireAccess = false; return json(res, 401, { message: 'Sign in to continue' }); }

    if (rest === '/sessions' && req.method === 'GET') {
      const list = ctl.sessions.slice(0, ctl.sessions.length - ctl.hideFromListing);
      const start = url.searchParams.get('nextToken') ? Number(Buffer.from(url.searchParams.get('nextToken'), 'base64url').toString()) : 0;
      const size = ctl.pageSizes[Math.floor(start / 10) % ctl.pageSizes.length]; // deliberately uneven page sizes
      const items = list.slice(start, start + size), end = start + items.length;
      return json(res, 200, { items, totalCount: ctl.sessions.length, ...(end < list.length ? { nextToken: Buffer.from(String(end)).toString('base64url') } : {}) });
    }
    let mm = /^\/sessions\/([^/]+)$/.exec(rest);
    if (mm && req.method === 'GET') { const s = byId().get(decodeURIComponent(mm[1])); return s ? json(res, 200, { session: { ...s, seatAvailability: seatsLeft(s.sessionId) <= 0 ? 'unavailable' : s.seatAvailability } }) : json(res, 404, { message: 'no session' }); }
    if (rest === '/schedule') return json(res, 200, { schedule: { reserved: [...ctl.reserved], favorites: [...ctl.favorites], personalTime: [] } });

    if (rest === '/reservations' && req.method === 'POST') {
      if (!ctl.open) return json(res, 409, { message: 'Reservations are not open yet.' });
      const ids = body.sessionIds;
      if (Date.now() - ctl.quotaWindow > 60_000) { ctl.quotaWindow = Date.now(); ctl.quotaUsed = 0; }
      if (ctl.quotaUsed + ids.length > ctl.quotaPerMinute) return json(res, 429, { message: 'slow down' }, { 'Retry-After': String(Math.ceil((60_000 - (Date.now() - ctl.quotaWindow)) / 1000)) });
      if (ctl.failNext === '503') { ctl.failNext = null; return json(res, 503, { message: 'unavailable' }); }
      ctl.quotaUsed += ids.length; ctl.writes++; ctl.reserveCalls.push(ids);
      const map = byId(), successful = [], failed = [];
      for (const id of ids) {
        const s = map.get(id);
        if (!s) { failed.push({ sessionId: id, code: 'other' }); continue; }
        if (ctl.reserved.has(id)) { failed.push({ sessionId: id, code: 'alreadyScheduled' }); continue; }
        if (!s.isReservable) { failed.push({ sessionId: id, code: 'sessionNotReservable' }); continue; }
        if (seatsLeft(id) <= 0) { failed.push({ sessionId: id, code: 'sessionFull' }); continue; }
        const clash = [...ctl.reserved].map(x => map.get(x)).filter(x => x && overlap(x, s));
        if (clash.length) { failed.push({ sessionId: id, code: 'scheduleConflict', conflictsWith: clash.map(c => c.sessionId) }); continue; }
        ctl.reserved.add(id); successful.push(id);
      }
      if (ctl.failNext === 'apply-then-503') { ctl.failNext = null; return json(res, 503, { message: 'unavailable' }); } // applied, but the caller never learns
      return json(res, 200, { result: { successful, failed } });
    }
    mm = /^\/reservations\/([^/]+)$/.exec(rest);
    if (mm && req.method === 'DELETE') { const id = decodeURIComponent(mm[1]); ctl.writes++; return ctl.reserved.delete(id) ? json(res, 204) : json(res, 404, { message: 'not reserved' }); }
    if (rest === '/favorites' && req.method === 'POST') { ctl.writes++; body.sessionIds.forEach(i => ctl.favorites.add(i)); return json(res, 200, { result: { successful: body.sessionIds, failed: [] } }); }
    return json(res, 404, { message: 'not found' });
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  const base = `http://127.0.0.1:${actual}`;
  const control = async (set, capacity) => { await fetch(`${base}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set, capacity }) }); };
  return { base, port: actual, ctl, control, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const mock = await startMock({ port: Number(process.env.MOCK_PORT) || 9000, open: process.env.MOCK_OPEN !== '0' });
  console.log(`Mock Events API on ${mock.base}`);
  console.log(`Run the app against it:  EVENTS_API_BASE=${mock.base} EVENTS_OAUTH_BASE=${mock.base} node server.js`);
}
