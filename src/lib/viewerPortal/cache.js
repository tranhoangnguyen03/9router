const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 4;

if (!globalThis._forkViewerPortalUsageCache) {
  globalThis._forkViewerPortalUsageCache = { entries: new Map(), inFlight: new Map(), generation: 0 };
}

const state = globalThis._forkViewerPortalUsageCache;
if (!Number.isSafeInteger(state.generation)) state.generation = 0;

function prune(now) {
  for (const [key, entry] of state.entries) {
    if (entry.expiresAt <= now) state.entries.delete(key);
  }
  while (state.entries.size > MAX_ENTRIES) {
    state.entries.delete(state.entries.keys().next().value);
  }
}

export async function getCachedPortalUsage(cacheKey, compute, now = Date.now()) {
  prune(now);
  const cached = state.entries.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  if (state.inFlight.has(cacheKey)) return state.inFlight.get(cacheKey);

  const generation = state.generation;
  let pending;
  pending = Promise.resolve()
    .then(compute)
    .then((value) => {
      if (state.generation === generation) {
        state.entries.delete(cacheKey);
        state.entries.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        prune(Date.now());
      }
      return value;
    })
    .finally(() => {
      if (state.inFlight.get(cacheKey) === pending) state.inFlight.delete(cacheKey);
    });

  state.inFlight.set(cacheKey, pending);
  return pending;
}

export function clearPortalUsageCache() {
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export const __test__ = { CACHE_TTL_MS, MAX_ENTRIES, state };
