import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.SNIPER_DATA_DIR || path.join(os.homedir(), '.reinvent-sniper');
export const API_BASE = process.env.EVENTS_API_BASE || 'https://api.awsevents.com';
export const OAUTH_BASE = process.env.EVENTS_OAUTH_BASE || 'https://oauth.awsevents.com';
export const CLIENT_ID = '7vmom55m1qstvq8i71ph127bfq';
export const SCOPE = 'openid email events/access';
export const EVENT_ID = process.env.EVENT_ID || 'reinvent2026';
// AWS reserves exactly these loopback ports for locally-run apps.
export const PORTS = [8484, 8485, 8486, 8487, 8488, 8489];

// AWS docs ("What is the AWS Events API?"): reserved seating opens on Oct 6 on the website and app, but "does not open
// through this API until October 8, 2026". Until then reserving returns 409. The time of day on Oct 8 is not announced, so the
// default is the earliest possible moment, the start of Oct 8 Pacific time (07:00 UTC). Editable in the app.
// (A community Slack message said half the seats are released at 9 AM PT and half at 5 PM PT on Oct 6. That is the website release, not the API.)
// The booker polls regardless of these times, so a wrong guess only changes how fast it polls, not whether it notices.
export const DEFAULT_WAVES = ['2026-10-08T07:00:00Z'];
export const API_OPENS_AT = Date.parse('2026-10-08T07:00:00Z');
