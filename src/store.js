import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
const file = name => path.join(DATA_DIR, name);

export function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

export function writeJson(name, value, { secret = false } = {}) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, file(name));
}

export function removeFile(name) { try { fs.unlinkSync(file(name)); } catch { /* already gone */ } }

export const DEFAULT_SETTINGS = {
  mailTo: '', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpUser: '', smtpPass: '',
  timezone: 'Asia/Kolkata',
  waves: null, // null = defaults from config
  pollSlowSec: 20, pollNearSec: 5, pollFastSec: 3,
};
// A settings file written by an earlier version may hold fields that no longer exist. Keep only the settings this version knows,
// so a leftover is dropped on load and never written back.
export const getSettings = () => {
  const s = { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
  for (const k of Object.keys(s)) if (!(k in DEFAULT_SETTINGS)) delete s[k];
  return s;
};
export const saveSettings = s => writeJson('settings.json', s, { secret: true });

export const getPlan = () => readJson('plan.json', { items: [] }); // items: [{sessionId, tier}]
export const savePlan = p => writeJson('plan.json', p);
export const getProfile = () => readJson('profile.json', { likes: [], skips: [] });
export const saveProfile = p => writeJson('profile.json', p);
// Sessions you marked "Not interested". Kept on this computer so they stay out of the list after a reload.
export const getDismissed = () => readJson('dismissed.json', { ids: [] }).ids;
export const saveDismissed = ids => writeJson('dismissed.json', { ids });
// Your own calendar entries and the parties you marked "going". Parties come from a third-party list, so only their ids are kept here.
export const getMyEvents = () => ({ going: [], custom: [], ...readJson('events.json', {}) });
export const saveMyEvents = e => writeJson('events.json', e);
// Where you left the screen: filters, search, sort, open sections, tab, scroll. Restored on reload and restart.
export const getUi = () => readJson('ui.json', {});
export const saveUi = u => writeJson('ui.json', u);
// The last booking run, so a crash or restart in the middle of a watch can pick up where it left off.
export const getRun = () => readJson('run.json', null);
export const saveRun = r => writeJson('run.json', r);
