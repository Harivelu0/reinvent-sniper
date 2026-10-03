import { API_BASE, EVENT_ID } from './config.js';
import { getAccessToken, AuthRequiredError } from './auth.js';

export class ApiError extends Error {
  constructor(status, body, retryAfter) { super(body?.message || `HTTP ${status}`); this.name = 'ApiError'; this.status = status; this.body = body; this.retryAfter = retryAfter; }
}
export class OperationClosedError extends ApiError { constructor(b) { super(409, b); this.name = 'OperationClosedError'; } }
export class NotRegisteredError extends ApiError {
  constructor(b) { super(403, b); this.name = 'NotRegisteredError'; this.message = 'This Builder ID is not registered for re:Invent 2026. Register on the event site first.'; }
}
// A write whose outcome we never learned. The API has no idempotency key: read GetSchedule before sending again.
export class UncertainWriteError extends Error { constructor(msg) { super(msg); this.name = 'UncertainWriteError'; } }

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class EventsClient {
  constructor({ eventId = EVENT_ID, base = API_BASE, sleepFn = sleep } = {}) { this.eventId = eventId; this.base = base; this.sleep = sleepFn; }

  async request(method, path, { query, body, auth = true, write = false, max429 = 4 } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let refreshed = false, retries429 = 0, attempt = 0;
    for (;;) {
      const headers = {};
      if (auth) headers.Authorization = `Bearer ${await getAccessToken({ force: refreshed })}`;
      if (body) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (write) throw new UncertainWriteError(`No response to ${method} ${path} (${e.message}).`);
        if (++attempt > 3) throw e;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* edge errors may be HTML or empty */ }
      if (res.ok) return json;
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      if (res.status === 401 && auth && !refreshed) { refreshed = true; continue; }
      if (res.status === 401) throw new AuthRequiredError('Your sign-in is no longer valid. Sign in again.');
      if (res.status === 403 && json) throw new NotRegisteredError(json);
      if (res.status === 409) throw new OperationClosedError(json);
      if (res.status === 429 && retries429++ < max429) { await this.sleep(Math.min(retryAfter || 5, 65) * 1000); continue; }
      if (res.status >= 500) {
        if (write) throw new UncertainWriteError(`${method} ${path} returned ${res.status}.`);
        if (++attempt <= 3) { await this.sleep(500 * 2 ** attempt); continue; }
      }
      throw new ApiError(res.status, json, retryAfter);
    }
  }

  getEvent() { return this.request('GET', `/v1/events/${this.eventId}`, { auth: false }).then(r => r.event ?? r); }
  getSession(id) { return this.request('GET', `/v1/events/${this.eventId}/sessions/${encodeURIComponent(id)}`).then(r => r.session ?? r); }
  getSchedule() { return this.request('GET', `/v1/events/${this.eventId}/schedule`).then(r => r.schedule ?? r); }
  listSessionsPage(nextToken) { return this.request('GET', `/v1/events/${this.eventId}/sessions`, { query: { nextToken } }); }
  reserve(sessionIds) { return this.request('POST', `/v1/events/${this.eventId}/reservations`, { body: { sessionIds }, write: true, max429: 0 }).then(r => r.result ?? r); }
  cancel(sessionId) { return this.request('DELETE', `/v1/events/${this.eventId}/reservations/${encodeURIComponent(sessionId)}`, { write: true }); }
  favorite(sessionIds) { return this.request('POST', `/v1/events/${this.eventId}/favorites`, { body: { sessionIds }, write: true }).then(r => r.result ?? r); }
}
