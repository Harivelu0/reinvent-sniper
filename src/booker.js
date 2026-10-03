import { OperationClosedError, UncertainWriteError, ApiError } from './api.js';
import { AuthRequiredError } from './auth.js';
import { DEFAULT_WAVES } from './config.js';
import { overlaps, SEAT_LABEL } from '../web/shared.js';
import { reportEmail } from './notify.js';
import { writeJson } from './store.js';

const realSleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_ON_FULL = new Set(['sessionFull', 'sessionNotReservable', 'scheduleConflict']);
const MAX_BATCH = 10; // API limit per ReserveSessions call

/**
 * Reserves sessions from the plan. Rules it follows:
 *  - Must-haves first, then nice-to-haves, in plan order, up to 10 per request.
 *  - A full / clashing session is replaced by a backup that overlaps its time slot.
 *  - Reads every per-session result: a 200 does not mean every session worked.
 *  - After a timeout or 5xx it never re-sends. It reads GetSchedule and sends only what is still missing.
 *  - 409 means reservations are not open yet: wait and try the same batch again.
 *  - Rehearse mode sends no writes at all.
 */
export class Booker {
  constructor({ client, getPlan, getCatalog, getSettings, notify = async () => ({ ok: true }), now = Date.now, sleep = realSleep, persist = () => {} } = {}) {
    Object.assign(this, { client, getPlan, getCatalog, getSettings, notify, now, sleep, persist });
    this.reset();
  }

  reset() {
    this.state = { status: 'idle', mode: 'rehearse', log: [], rows: [], wave: null, nextWaveAt: null, error: null, startedAt: null, finishedAt: null };
    this.stopRequested = false;
  }

  /* ---------- keeping state across restarts ---------- */
  saveNow() { this.persist({ savedAt: Date.now(), state: { ...this.state, log: this.state.log.slice(-300) } }); }
  saveSoon() { // log lines can come in bursts; write at most about once a second
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
    this.saveTimer.unref?.();
  }

  /**
   * Called once at startup with the last saved run. A live watch that was still waiting or booking when the app died
   * (crash, reboot, closed laptop) is resumed. A watch the user stopped, or one that finished, is only shown.
   * It never re-reserves what it already holds: every pass starts from GetSchedule.
   */
  restore(saved, { maxAgeMs = 5 * 864e5 } = {}) {
    if (!saved?.state) return { resume: false };
    this.state = { ...saved.state, error: saved.state.error ?? null };
    const wasActive = ['waiting', 'booking'].includes(saved.state.status);
    if (!wasActive) return { resume: false };
    const fresh = this.now() - (saved.savedAt || 0) < maxAgeMs;
    if (saved.state.mode !== 'live' || !fresh) {
      this.state.status = 'stopped';
      this.log(fresh ? 'A rehearsal was interrupted when the app closed.' : 'The previous watch was too old to resume on its own. Press Start if you still want it.', 'wr');
      this.saveNow();
      return { resume: false };
    }
    return { resume: true };
  }

  /* ---------- helpers ---------- */
  log(msg, level = '') {
    this.state.log.push({ t: this.now(), level, msg });
    if (this.state.log.length > 600) this.state.log.splice(0, this.state.log.length - 600);
    this.saveSoon();
  }
  get live() { return this.state.mode === 'live'; }
  waves() {
    const list = (this.getSettings().waves?.length ? this.getSettings().waves : DEFAULT_WAVES).map(w => Date.parse(w)).filter(Number.isFinite);
    return list.sort((a, b) => a - b);
  }
  model() {
    const cat = this.getCatalog();
    const byId = new Map((cat?.sessions || []).map(s => [s.sessionId, s]));
    const items = this.getPlan().items.map(i => ({ ...i, s: byId.get(i.sessionId) })).filter(i => i.s);
    const tier = t => items.filter(i => i.tier === t).map(i => i.s);
    return { byId, must: tier('Must-have'), nice: tier('Nice-to-have'), backups: tier('Backup') };
  }
  backupsFor(s, m) { return m.backups.filter(b => overlaps(b, s)); }

  pollSeconds() {
    const st = this.getSettings(), t = this.now();
    for (const w of this.waves()) {
      if (t >= w - 60_000 && t <= w + 10 * 60_000) return st.pollFastSec;
      if (t >= w - 10 * 60_000 && t < w - 60_000) return st.pollNearSec;
    }
    return st.pollSlowSec;
  }

  /* ---------- one reservation request, with every failure mode handled ---------- */
  async attempt(batch, held, depth = 0) {
    if (!this.live) return this.predict(batch);
    for (;;) {
      if (this.stopRequested) throw new Error('stopped');
      try {
        const r = await this.client.reserve(batch.map(s => s.sessionId));
        if (this.state.status === 'waiting') {
          this.state.status = 'booking'; this.log('Reservations are open. Booking now.', 'ok');
          if (!this.opened) {
            this.opened = true;
            const { html, text } = reportEmail({ heading: 'Reservations just opened', rows: [], footer: 'The booker is reserving your plan now. A full report follows.' });
            this.notify('re:Invent reservations just opened', html, text);
          }
        }
        return r;
      } catch (e) {
        if (e instanceof OperationClosedError) {
          this.state.status = 'waiting';
          const secs = this.pollSeconds();
          if (!this.closedLogged || this.now() - this.closedLogged > 60_000) { this.log(`Reservations are still closed (409). Checking every ${secs}s.`, 'tm'); this.closedLogged = this.now(); }
          await this.sleep(secs * 1000);
          continue;
        }
        if (e instanceof ApiError && e.status === 429) {
          if (batch.length > 1 && depth < 3) { // a refused request spends no quota, so a smaller batch can go straight away
            const half = Math.ceil(batch.length / 2);
            this.log(`Rate limit hit. Sending ${half} at a time.`, 'wr');
            const a = await this.attempt(batch.slice(0, half), held, depth + 1);
            const b = await this.attempt(batch.slice(half), held, depth + 1);
            return { successful: [...a.successful, ...b.successful], failed: [...a.failed, ...b.failed] };
          }
          const wait = Math.min(e.retryAfter || 10, 65);
          this.log(`Rate limit hit. Waiting ${wait}s as the API asks.`, 'wr');
          await this.sleep(wait * 1000);
          continue;
        }
        if (e instanceof UncertainWriteError) { // never re-send blindly: read the schedule and work out what landed
          this.log(`${e.message} Checking your schedule before trying again.`, 'wr');
          const sched = await this.client.getSchedule();
          const nowHeld = new Set(sched.reserved);
          const ok = batch.filter(s => nowHeld.has(s.sessionId) && !held.has(s.sessionId)).map(s => s.sessionId);
          const rest = batch.filter(s => !nowHeld.has(s.sessionId));
          if (rest.length && depth < 2) {
            const more = await this.attempt(rest, held, depth + 1);
            return { successful: [...ok, ...more.successful], failed: more.failed };
          }
          return { successful: ok, failed: rest.map(s => ({ sessionId: s.sessionId, code: 'other' })) };
        }
        throw e;
      }
    }
  }

  /** Rehearse: guess the outcome from the latest seat band. Clearly labelled as a prediction in the log. */
  predict(batch) {
    const successful = [], failed = [];
    for (const s of batch) {
      if (s.seatAvailability === 'unavailable') failed.push({ sessionId: s.sessionId, code: 'sessionFull' });
      // Before reserved seating opens every session says "not reservable". That is not a refusal, just no information yet.
      else if (s.isReservable === false && !this.noSeatInfoYet) failed.push({ sessionId: s.sessionId, code: 'sessionNotReservable' });
      else successful.push(s.sessionId);
    }
    return { successful, failed };
  }

  /* ---------- one full pass over the plan ---------- */
  async pass(label) {
    const m = this.model();
    if (!this.live) { // rehearse: use today's seat bands, not the ones from when the catalog was downloaded
      for (const s of [...m.must, ...m.nice, ...m.backups]) {
        try { const f = await this.client.getSession(s.sessionId); s.seatAvailability = f.seatAvailability; s.isReservable = f.isReservable; } catch { /* keep the synced values */ }
      }
      this.noSeatInfoYet = [...m.byId.values()].every(s => s.isReservable === false);
      if (this.noSeatInfoYet) this.log('Seat availability is not published yet (every session is marked not reservable). This rehearsal assumes seats will be available, so it shows the order and the clash checks, not who will be full.', 'wr');
    }
    const sched = this.live ? await this.client.getSchedule() : { reserved: [] };
    const held = new Set(sched.reserved);
    const booked = [...held].map(id => m.byId.get(id)).filter(Boolean);
    const rows = new Map(); // sessionId -> { s, tier, kind, status, note }
    const row = (s, tier, kind, status, note = '') => rows.set(s.sessionId, { s, tier, kind, status, note });
    let queue = [...m.must, ...m.nice].map(s => ({ s, origin: null }));
    const tried = new Set();
    const tierOf = id => this.getPlan().items.find(i => i.sessionId === id)?.tier;

    for (const { s } of queue) if (held.has(s.sessionId)) row(s, tierOf(s.sessionId), 'reserved', 'Already reserved');
    queue = queue.filter(q => !held.has(q.s.sessionId));

    while (queue.length && !this.stopRequested) {
      const batch = [];
      for (const q of [...queue]) {
        const id = q.s.sessionId;
        if (tried.has(id)) { queue.splice(queue.indexOf(q), 1); continue; }
        const heldClash = booked.find(b => overlaps(b, q.s));
        if (heldClash) { // this slot is already taken by something on the schedule
          queue.splice(queue.indexOf(q), 1);
          if (!rows.has(id)) {
            const isBackup = m.backups.some(b => b.sessionId === heldClash.sessionId);
            row(q.s, tierOf(id), 'other', isBackup ? 'Backup holds this slot' : 'Skipped',
              isBackup ? `${heldClash.code} is reserved here. Swap if ${q.s.code} has seats now.` : `Overlaps ${heldClash.code}, which you already hold.`);
          }
          continue;
        }
        if (batch.some(b => overlaps(b.s, q.s))) continue; // same slot as something in this request: leave it for the next one
        batch.push(q);
        if (batch.length === MAX_BATCH) break;
      }
      if (!batch.length) break;
      batch.forEach(q => { queue.splice(queue.indexOf(q), 1); tried.add(q.s.sessionId); });
      this.log(`${label}: ${this.live ? 'reserving' : 'would reserve'} ${batch.map(q => q.s.code).join(', ')}`);
      const res = await this.attempt(batch.map(q => q.s), held);
      const byId = new Map(batch.map(q => [q.s.sessionId, q]));
      for (const id of res.successful) {
        const q = byId.get(id); booked.push(q.s); held.add(id);
        if (q.origin) row(q.s, 'Backup', 'backup', 'Reserved as backup', `Stands in for ${q.origin.code}.`);
        else row(q.s, tierOf(id), 'reserved', 'Reserved');
        this.log(`${q.s.code} ${this.live ? 'reserved' : 'would be reserved'}${q.origin ? ` (backup for ${q.origin.code})` : ''}`, 'ok');
      }
      for (const f of res.failed) {
        const q = byId.get(f.sessionId); if (!q) continue;
        if (f.code === 'alreadyScheduled') { booked.push(q.s); held.add(f.sessionId); row(q.s, tierOf(f.sessionId), 'reserved', 'Already reserved'); continue; }
        const full = f.code === 'sessionFull';
        const root = q.origin || q.s;
        this.log(`${q.s.code} refused: ${f.code}${f.conflictsWith?.length ? ` (clashes with ${f.conflictsWith.map(c => m.byId.get(c)?.code || c).join(', ')})` : ''}`, 'wr');
        if (!q.origin) row(q.s, tierOf(f.sessionId), full ? 'full' : 'other', full ? 'Full' : `Not booked (${f.code})`, full ? 'Will be retried at the next wave.' : '');
        else if (!rows.has(f.sessionId)) row(q.s, 'Backup', 'other', `Backup refused (${f.code})`);
        if (RETRY_ON_FULL.has(f.code)) {
          const next = this.backupsFor(root, m).filter(b => !tried.has(b.sessionId) && !booked.some(x => overlaps(x, b)));
          if (next.length && !booked.some(x => overlaps(x, root))) queue.unshift({ s: next[0], origin: root });
        }
      }
    }
    return { rows: [...rows.values()], held, m };
  }

  /* ---------- the whole run ---------- */
  async start({ mode = 'rehearse', resumed = false } = {}) {
    if (['waiting', 'booking'].includes(this.state.status) && this.runPromise) throw new Error('A run is already in progress.');
    const keep = resumed ? this.state.log : [];
    const startedAt = resumed ? this.state.startedAt : this.now();
    this.reset();
    Object.assign(this.state, { mode, status: 'waiting', startedAt, log: keep });
    this.closedLogged = 0; this.opened = false;
    if (resumed) this.log('The app restarted while this watch was running. Resuming. Anything already reserved is left alone.', 'wr');
    this.saveNow();
    this.runPromise = this.run().catch(e => this.fail(e)).finally(() => { this.runPromise = null; this.saveNow(); });
    return this.state;
  }

  stop() {
    this.stopRequested = true;
    if (['waiting', 'booking'].includes(this.state.status)) { this.state.status = 'stopped'; this.log('Stopped.', 'wr'); }
    this.saveNow();
  }

  async fail(e) {
    if (e.message === 'stopped') return;
    this.state.status = 'error'; this.state.error = e.message;
    this.log(`Stopped: ${e.message}`, 'er');
    if (e instanceof AuthRequiredError && this.live) {
      const { html, text } = reportEmail({ heading: 'Booking paused: sign in again', rows: [], footer: 'Your Builder ID sign-in expired while the booker was running. Open the app and sign in again, then press Start watching.' });
      await this.notify('Reinvent Sniper needs you to sign in again', html, text);
    }
  }

  async run() {
    const m0 = this.model();
    if (!m0.must.length && !m0.nice.length) throw new Error('Add at least one must-have or nice-to-have session to your plan first.');
    this.log(`${this.live ? 'LIVE' : 'Rehearse'} run started: ${m0.must.length} must-have, ${m0.nice.length} nice-to-have, ${m0.backups.length} backup.`);
    if (this.live) { await this.client.getSchedule().catch(e => { if (!(e instanceof OperationClosedError)) throw e; }); this.log('Signed in and registered. Schedule readable.', 'ok'); }

    const waves = this.waves();
    if (!this.live) this.state.status = 'booking';
    let label = 'First pass';
    for (;;) {
      if (this.stopRequested) return;
      // The first pass starts at once. While reservations are closed, attempt() waits and polls on its own.
      const out = await this.pass(label);
      if (this.stopRequested) return;
      this.state.rows = out.rows.map(r => ({ code: r.s.code, sessionId: r.s.sessionId, title: r.s.title, when: `${r.s.sessionTime?.date || ''} ${r.s.sessionTime?.time || ''}`.trim(), tier: r.tier, kind: r.kind, status: r.status, note: r.note }));
      // Verify against the real schedule.
      if (this.live) {
        const sched = await this.client.getSchedule();
        const reserved = new Set(sched.reserved);
        const wrong = out.rows.filter(r => ['reserved', 'backup'].includes(r.kind) && !reserved.has(r.s.sessionId));
        if (wrong.length) this.log(`Warning: ${wrong.map(r => r.s.code).join(', ')} not on your schedule after booking. Check the event site.`, 'er');
        else this.log('Verified against your real schedule.', 'ok');
      }
      const retry = out.rows.filter(r => r.kind === 'full' && !this.backupHeld(r, out));
      const booked = out.rows.filter(r => ['reserved', 'backup'].includes(r.kind)).length;
      const { html, text } = reportEmail({
        heading: `${this.live ? '' : 'Rehearse: '}${booked} session${booked === 1 ? '' : 's'} booked (${label.toLowerCase()})${retry.length ? `, ${retry.length} to retry` : ''}`,
        rows: this.state.rows,
        footer: this.live ? 'Checked against your real schedule after booking.' : 'Rehearse run: nothing was reserved.',
      });
      await this.notify(`re:Invent seats: ${booked} booked (${label.toLowerCase()})`, html, text);
      // Sessions that were full may get more seats at the next wave. Wait for it, then try only what is still missing.
      const next = waves.findIndex(w => w - 30_000 > this.now());
      if (!retry.length || next < 0 || !this.live) break;
      label = `Wave ${next + 1}`;
      this.state.wave = next + 1; this.state.nextWaveAt = waves[next]; this.state.status = 'waiting';
      this.log(`${retry.length} session(s) were full. Retrying at wave ${next + 1}.`, 'wr');
      while (this.now() < waves[next] - 30_000) {
        if (this.stopRequested) return;
        await this.sleep(Math.min(15_000, waves[next] - 30_000 - this.now()));
      }
      this.state.status = 'booking';
    }
    this.state.status = this.stopRequested ? 'stopped' : 'done';
    this.state.finishedAt = this.now();
    this.log(this.live ? 'Finished.' : 'Rehearsal finished. Nothing was reserved. This is a prediction from the latest seat information.', 'ok');
    writeJson('booking.json', { finishedAt: this.state.finishedAt, mode: this.state.mode, rows: this.state.rows });
  }

  backupHeld(row, out) { // a full must-have whose slot is already covered by a booked backup is a swap candidate, not a retry
    return out.rows.some(r => r.kind === 'backup' && overlaps(r.s, row.s));
  }

  /** Cancel the backup in this slot and reserve the original. Puts the backup back if the original fails. */
  async swap(sessionId) {
    if (!this.live && !this.client) throw new Error('Not available.');
    const m = this.model();
    const orig = m.byId.get(sessionId); if (!orig) throw new Error('Unknown session.');
    const sched = await this.client.getSchedule();
    const heldBackups = m.backups.filter(b => sched.reserved.includes(b.sessionId) && overlaps(b, orig));
    if (!heldBackups.length) throw new Error('No backup is holding that slot.');
    const fresh = await this.client.getSession(sessionId);
    if (fresh.seatAvailability === 'unavailable') throw new Error(`${orig.code} still shows as full (${SEAT_LABEL.unavailable}). Keeping your backup.`);
    const backup = heldBackups[0];
    await this.client.cancel(backup.sessionId);
    const r = await this.client.reserve([sessionId]);
    if (r.successful.includes(sessionId)) { this.log(`Swapped ${backup.code} for ${orig.code}.`, 'ok'); return { swapped: true }; }
    await this.client.reserve([backup.sessionId]).catch(() => {});
    throw new Error(`${orig.code} could not be reserved (${r.failed[0]?.code || 'unknown'}). Your backup ${backup.code} was put back.`);
  }
}
