/**
 * cache.ts — tiny on-disk cache keyed by exact API request parameters.
 *
 * Why this exists: a real conversation with this skill looks like "compare
 * X in Polish and Czech" followed by "now add Slovak" followed by "actually
 * make it 3 years not 2." Re-fetching Polish and Czech data every time
 * wastes a round trip and, more importantly, wastes the agent's turns.
 * Cache hits are keyed on the exact (project, article, granularity, start,
 * end, access, agent) tuple, so a wider date range or a different access
 * filter correctly misses the cache rather than silently reusing
 * stale/mismatched data.
 *
 * Not meant to be clever: no expiry logic beyond a max age, because
 * pageview counts for past months never change after Wikimedia finalizes
 * them. Only requests touching the most recent ~2 months are worth ever
 * re-fetching, and this cache defaults to trusting any cached response
 * younger than 1 day, which is deliberately conservative rather than
 * trying to model Wikimedia's publication schedule.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CACHE_DIR = process.env.WIKIPEDIA_TREND_CACHE_DIR ?? join(process.cwd(), ".wikipedia_trend_cache");
const MAX_AGE_MS = 24 * 3600 * 1000;

function keyFor(params: Record<string, unknown>): string {
  const blob = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(blob).digest("hex").slice(0, 24);
}

export function cacheGet<T>(params: Record<string, unknown>, cacheDir = DEFAULT_CACHE_DIR): T | null {
  const path = join(cacheDir, `${keyFor(params)}.json`);
  if (!existsSync(path)) return null;
  const payload = JSON.parse(readFileSync(path, "utf-8"));
  if (Date.now() - payload.cachedAt > MAX_AGE_MS) return null;
  return payload.data as T;
}

export function cacheSet(params: Record<string, unknown>, data: unknown, cacheDir = DEFAULT_CACHE_DIR): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `${keyFor(params)}.json`);
  writeFileSync(path, JSON.stringify({ cachedAt: Date.now(), params, data }));
}
