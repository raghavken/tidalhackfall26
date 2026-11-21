// Patient Overpass fetching for the offline download scripts.
// The main server (overpass-api.de) is the one that actually answers, but it
// often replies "502 at capacity" instantly; that's transient, so retry it
// quickly. The mirrors tend to hang, so they're only tried occasionally.

import { OVERPASS_URLS } from './overpass.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST `query` until one attempt succeeds. Returns the parsed JSON.
 * attempts: total tries; every `mirrorEvery`-th try goes to a mirror.
 */
export async function overpassWithRetry(query, { attempts = 12, perTryMs = 150000, pauseMs = 8000,
  mirrorEvery = 4, log = () => {}, fetchImpl = fetch } = {}) {
  const [main, ...mirrors] = OVERPASS_URLS;
  const errors = [];
  for (let i = 1; i <= attempts; i++) {
    const url = i % mirrorEvery === 0 ? mirrors[(i / mirrorEvery - 1) % mirrors.length] : main;
    const t0 = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'oscillation-cartographer/0.1 (hackathon demo)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(perTryMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      const msg = `${new URL(url).host} try ${i}: ${error.message} (${Math.round((Date.now() - t0) / 1000)} s)`;
      errors.push(msg);
      log(msg);
      if (i < attempts) await sleep(pauseMs);
    }
  }
  throw new Error('Overpass unavailable after retries: ' + errors.slice(-3).join('; '));
}
