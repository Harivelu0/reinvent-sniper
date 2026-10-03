import crypto from 'node:crypto';
import { OAUTH_BASE, CLIENT_ID, SCOPE } from './config.js';
import { readJson, writeJson, removeFile } from './store.js';

export class AuthRequiredError extends Error {
  constructor(msg = 'Sign in with your Builder ID to continue.') { super(msg); this.name = 'AuthRequiredError'; }
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const pending = new Map(); // state -> { verifier, redirectUri, createdAt }
let refreshing = null;     // single in-flight refresh, so parallel calls never rotate the token twice

export function buildAuthUrl(port) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const redirectUri = `http://localhost:${port}/callback`;
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 10 * 60_000) pending.delete(k);
  pending.set(state, { verifier, redirectUri, createdAt: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE,
    identity_provider: 'AWSBuilderID', code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return `${OAUTH_BASE}/oauth2/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${OAUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json, text };
}

function saveTokens(t, prev = {}) {
  const now = Date.now();
  const tokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || prev.refreshToken, // keep the old one if the server did not rotate it
    idToken: t.id_token || prev.idToken,
    expiresAt: now + (Number(t.expires_in) || 3600) * 1000,
    refreshIssuedAt: t.refresh_token ? now : prev.refreshIssuedAt || now,
    signedInAt: prev.signedInAt || now,
  };
  writeJson('tokens.json', tokens, { secret: true });
  return tokens;
}

export async function completeSignIn({ code, state }) {
  const p = pending.get(state);
  if (!p) throw new Error('Sign-in expired or was not started here. Start again.');
  pending.delete(state);
  const r = await tokenRequest({ grant_type: 'authorization_code', redirect_uri: p.redirectUri, code, code_verifier: p.verifier });
  if (!r.ok) throw new Error(`Sign-in failed (${r.status}): ${r.json.error_description || r.json.error || r.text.slice(0, 120)}`);
  saveTokens(r.json);
}

export const loadTokens = () => readJson('tokens.json', null);
export function signOut() { removeFile('tokens.json'); }

export function decodeEmail(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email || null; } catch { return null; }
}

export function authStatus() {
  const t = loadTokens();
  if (!t?.refreshToken) return { signedIn: false };
  const refreshExpires = (t.refreshIssuedAt || t.signedInAt) + 30 * 864e5;
  return { signedIn: true, email: decodeEmail(t.idToken), accessExpiresAt: t.expiresAt, refreshExpiresAt: refreshExpires };
}

export async function refreshNow() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = loadTokens();
    if (!t?.refreshToken) throw new AuthRequiredError();
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
    if (!r.ok) {
      // 400/401 invalid_grant means the refresh token is dead; anything else may be transient.
      if (r.status === 400 || r.status === 401) { signOut(); throw new AuthRequiredError('Your sign-in expired. Sign in again.'); }
      throw new Error(`Token refresh failed (${r.status}). Try again shortly.`);
    }
    return saveTokens(r.json, t);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function getAccessToken({ force = false } = {}) {
  const t = loadTokens();
  if (!t?.refreshToken) throw new AuthRequiredError();
  if (!force && t.accessToken && t.expiresAt - Date.now() > 90_000) return t.accessToken;
  return (await refreshNow()).accessToken;
}
