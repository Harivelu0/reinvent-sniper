import { readJson, writeJson } from './store.js';
import { normalize } from '../web/shared.js';

export const loadCatalog = () => readJson('catalog.json', null);

/**
 * Downloads every session. Stops only when the API stops returning nextToken (a short page is not the last page),
 * then compares what arrived with the catalog's own totalCount, so a silent gap is reported instead of hidden.
 */
export async function syncCatalog(client, onProgress = () => {}) {
  const event = await client.getEvent().catch(() => null);
  const byId = new Map();
  let token, total = null, pages = 0;
  do {
    const page = await client.listSessionsPage(token);
    pages++;
    if (page.totalCount != null) total = page.totalCount;
    for (const s of page.items || []) byId.set(s.sessionId, normalize(s));
    token = page.nextToken;
    onProgress({ fetched: byId.size, total, pages });
  } while (token);
  const sessions = [...byId.values()];
  const warnings = [];
  if (total != null && sessions.length !== total) {
    warnings.push(`The catalog says it has ${total} sessions but ${sessions.length} arrived. Run Re-sync again before relying on the list.`);
  }
  const cat = { fetchedAt: new Date().toISOString(), totalCount: total, count: sessions.length, warnings, event, sessions };
  writeJson('catalog.json', cat);
  return cat;
}
