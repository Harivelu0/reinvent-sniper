// Import this first in a test file: it points the app at a throwaway data folder and a local mock of the Events API.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-test-'));
process.env.SNIPER_DATA_DIR = DATA_DIR;
const { startMock } = await import('../mock/mock-events.js');
export const mock = await startMock();
process.env.EVENTS_API_BASE = mock.base;
process.env.EVENTS_OAUTH_BASE = mock.base;

export function seedTokens({ expiresInMs = 3600e3 } = {}) {
  mock.ctl.tokens.set('acc-test', true);
  mock.ctl.currentRefresh = 'ref-test';
  fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), JSON.stringify({
    accessToken: 'acc-test', refreshToken: 'ref-test', expiresAt: Date.now() + expiresInMs, refreshIssuedAt: Date.now(), signedInAt: Date.now(),
  }));
}
