import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test__,
  clearPortalUsageCache,
  getCachedPortalUsage,
} from "@/lib/viewerPortal/cache";

describe("viewer portal aggregate cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    clearPortalUsageCache();
  });

  afterEach(() => {
    clearPortalUsageCache();
    vi.useRealTimers();
  });

  it("reuses a sanitized aggregate during the 30 second TTL", async () => {
    const compute = vi.fn(async () => ({ summary: { requests: 3 } }));
    const first = await getCachedPortalUsage("7d:config", compute);
    const second = await getCachedPortalUsage("7d:config", compute);

    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cache misses", async () => {
    let release;
    const compute = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const first = getCachedPortalUsage("24h:config", compute);
    const second = getCachedPortalUsage("24h:config", compute);
    await Promise.resolve();
    release({ summary: { requests: 9 } });

    await expect(first).resolves.toEqual({ summary: { requests: 9 } });
    await expect(second).resolves.toEqual({ summary: { requests: 9 } });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after expiry and never caches errors", async () => {
    const compute = vi.fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ version: 2 });

    await expect(getCachedPortalUsage("30d:config", compute)).resolves.toEqual({ version: 1 });
    vi.advanceTimersByTime(__test__.CACHE_TTL_MS + 1);
    await expect(getCachedPortalUsage("30d:config", compute)).rejects.toThrow("database unavailable");
    await expect(getCachedPortalUsage("30d:config", compute)).resolves.toEqual({ version: 2 });
  });

  it("keeps at most one entry for each supported period", async () => {
    for (let index = 0; index < 7; index += 1) {
      await getCachedPortalUsage(`period-${index}:config`, async () => ({ index }));
    }
    expect(__test__.state.entries.size).toBe(__test__.MAX_ENTRIES);
  });

  it("does not repopulate the cache from work invalidated while in flight", async () => {
    let release;
    const pending = getCachedPortalUsage("7d:old-config", () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    clearPortalUsageCache();
    release({ stale: true });
    await pending;
    expect(__test__.state.entries.size).toBe(0);
  });
});
