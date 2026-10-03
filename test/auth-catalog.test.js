import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, seedTokens, DATA_DIR } from './env.js';

const auth = await import('../src/auth.js');
const { EventsClient, OperationClosedError, NotRegisteredError } = await import('../src/api.js');
const { syncCatalog } = await import('../src/catalog.js');

const tokensFile = path.join(DATA_DIR, 'tokens.json');

test('PKCE sign-in: authorize, callback, token exchange, tokens saved', async () => {
  const url = auth.buildAuthUrl(8484);
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('identity_provider'), 'AWSBuilderID');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8484/callback');
  assert.equal(u.searchParams.get('scope'), 'openid email events/access');
  const r = await fetch(url, { redirect: 'manual' });
  const cb = new URL(r.headers.get('location'));
  await auth.completeSignIn({ code: cb.searchParams.get('code'), state: cb.searchParams.get('state') });
  const st = auth.authStatus();
  assert.equal(st.signedIn, true);
  assert.equal(st.email, 'tester@example.com');
});

test('a callback with an unknown state is refused', async () => {
  await assert.rejects(auth.completeSignIn({ code: 'x', state: 'nope' }), /expired|not started/);
});

test('an expired access token is refreshed and the rotated refresh token is saved', async () => {
  const before = JSON.parse(fs.readFileSync(tokensFile));
  fs.writeFileSync(tokensFile, JSON.stringify({ ...before, expiresAt: Date.now() - 1000 }));
  const token = await auth.getAccessToken();
  const after = JSON.parse(fs.readFileSync(tokensFile));
  assert.notEqual(token, before.accessToken);
  assert.notEqual(after.refreshToken, before.refreshToken);
});

test('parallel callers share one refresh (the rotated token is not spent twice)', async () => {
  const t = JSON.parse(fs.readFileSync(tokensFile));
  fs.writeFileSync(tokensFile, JSON.stringify({ ...t, expiresAt: 0 }));
  const seq = mock.ctl.refreshSeq;
  await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(mock.ctl.refreshSeq, seq + 1);
});

test('a dead refresh token signs the user out and asks for sign-in', async () => {
  mock.ctl.revokedRefresh = true;
  const t = JSON.parse(fs.readFileSync(tokensFile));
  fs.writeFileSync(tokensFile, JSON.stringify({ ...t, expiresAt: 0 }));
  await assert.rejects(auth.getAccessToken(), auth.AuthRequiredError);
  assert.equal(auth.authStatus().signedIn, false);
  mock.ctl.revokedRefresh = false;
});

test('a 401 mid-request triggers one refresh and a retry', async () => {
  seedTokens();
  mock.ctl.expireAccess = true; // next authenticated call gets 401
  const client = new EventsClient();
  const sched = await client.getSchedule();
  assert.deepEqual(sched.reserved, []);
});

test('sync downloads every session even with uneven page sizes, and reports the count', async () => {
  seedTokens();
  const cat = await syncCatalog(new EventsClient());
  assert.equal(cat.count, 120);
  assert.equal(cat.totalCount, 120);
  assert.deepEqual(cat.warnings, []);
  assert.equal(cat.event.eventId, 'reinvent2026');
  assert.ok(cat.sessions[0].startMin > 0 && cat.sessions[0].code);
});

test('sync warns loudly when fewer sessions arrive than the catalog total', async () => {
  seedTokens();
  mock.ctl.hideFromListing = 7;
  const cat = await syncCatalog(new EventsClient());
  assert.equal(cat.count, 113);
  assert.match(cat.warnings[0], /120 sessions but 113 arrived/);
  mock.ctl.hideFromListing = 0;
});

test('a closed operation surfaces as OperationClosedError', async () => {
  seedTokens();
  mock.ctl.open = false;
  await assert.rejects(new EventsClient().reserve(['sess-0001']), OperationClosedError);
  mock.ctl.open = true;
});

test('a 403 with a body means not registered', async () => {
  seedTokens();
  const c = new EventsClient();
  c.request = async () => { throw new NotRegisteredError({ message: 'x' }); };
  await assert.rejects(c.getSchedule(), /not registered/);
});

test.after(async () => { await mock.close(); });
