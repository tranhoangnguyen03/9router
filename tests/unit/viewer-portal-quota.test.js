import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: vi.fn(), settings: vi.fn(), upstream: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings, getProviderConnections: mocks.connections }));
vi.mock("@/lib/db/driver", () => ({ getAdapter: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route", () => ({ GET: mocks.upstream }));
const config = await import("@/lib/viewerPortal/config.js");
const quota = await import("@/lib/viewerPortal/quota.js");

const connection = (id, extra = {}) => ({ id, provider: "codex", authType: "oauth", name: "private@example.com", accessToken: "private-token", isActive: true, ...extra });
const upstreamQuota = () => Response.json({ email: "private@example.com", token: "private-token", quotas: { session: { used: 25, total: 100, remaining: 75, resetAt: "2026-09-13T10:00:00Z", secret: "private-token" } } });
function publish(accounts) {
  mocks.settings.mockResolvedValue({ forkExtensions: { viewerPortal: { enabled: true, passwordHash: "hash", quotaAccounts: accounts } } });
}

describe("portal quota contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quota.__test__.state.entries.clear();
    mocks.connections.mockResolvedValue([connection("one"), connection("private")]);
    mocks.upstream.mockImplementation(upstreamQuota);
    publish([{ connectionId: "one", label: "Shared Codex" }]);
  });
  afterEach(() => vi.useRealTimers());

  it("defaults old configurations to no published quotas and preserves normalized selection", () => {
    expect(config.normalizePortalConfig({}).quotaAccounts).toEqual([]);
    const accounts = [{ connectionId: "one", label: " Shared " }];
    expect(config.normalizePortalConfig({ quotaAccounts: accounts }).quotaAccounts).toEqual([{ connectionId: "one", label: "Shared" }]);
  });

  it("rejects invalid, duplicate, unsupported and oversized admin selections", () => {
    const valid = new Set(["one"]);
    expect(config.validateAndNormalizeQuotaAccounts([{ connectionId: "one", label: " Shared " }], valid)).toEqual([{ connectionId: "one", label: "Shared" }]);
    for (const bad of [null, {}, [null], [{ connectionId: "unknown" }], [{ connectionId: "one" }, { connectionId: "one" }], Array(101).fill({ connectionId: "one" }), [{ connectionId: "one", label: {} }]]) {
      expect(() => config.validateAndNormalizeQuotaAccounts(bad, valid)).toThrow();
    }
  });

  it("makes a quota-only portal available without exposing selected accounts publicly", () => {
    const result = config.toPublicPortalConfig({ enabled: true, passwordHash: "hash", quotaAccounts: [{ connectionId: "one", label: "Secret label" }] });
    expect(result.quotaAvailable).toBe(true);
    expect(result.usageAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/one|Secret label|hash/);
  });

  it("fetches only selected accounts through upstream, strips private fields and caches/coalesces", async () => {
    const [first, second] = await Promise.all([quota.getPortalQuota(), quota.getPortalQuota()]);
    expect(first.accounts).toEqual(second.accounts);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    const [request, context] = mocks.upstream.mock.calls[0];
    expect((await context.params).connectionId).toBe("one");
    expect(new URL(request.url).searchParams.has("force")).toBe(false);
    expect(first.accounts[0]).toMatchObject({ label: "Shared Codex", provider: "OpenAI Codex", status: "available", quotas: [{ name: "session", used: 25, total: 100, remainingPercentage: 75 }] });
    expect(JSON.stringify(first)).not.toMatch(/private|connectionId|accessToken|secret|\"one\"/);
    await quota.getPortalQuota();
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("immediately applies unpublication, labels and account deletion even with cached quotas", async () => {
    await quota.getPortalQuota();
    publish([{ connectionId: "one", label: "Renamed" }]);
    expect((await quota.getPortalQuota()).accounts[0].label).toBe("Renamed");
    publish([]);
    expect((await quota.getPortalQuota()).accounts).toEqual([]);
    publish([{ connectionId: "one", label: "Shared" }]);
    mocks.connections.mockResolvedValue([]);
    expect((await quota.getPortalQuota()).accounts).toEqual([]);
  });

  it("does not fetch disabled, unsupported or inactive accounts", async () => {
    publish([{ connectionId: "one", label: "One" }]);
    mocks.connections.mockResolvedValue([connection("one", { isActive: false })]);
    expect((await quota.getPortalQuota()).accounts[0].status).toBe("unavailable");
    expect(mocks.upstream).not.toHaveBeenCalled();
    mocks.connections.mockResolvedValue([connection("one", { provider: "no-usage-provider" })]);
    expect((await quota.getPortalQuota()).accounts).toEqual([]);
    mocks.settings.mockResolvedValue({});
    expect((await quota.getPortalQuota()).accounts).toEqual([]);
  });

  it("preserves unknown, unlimited and absolute-credit semantics without raw error disclosure", () => {
    const rows = quota.sanitizeQuotas({ quotas: {
      unknown: {}, credit: { used: 652, total: 1000, remaining: 348 },
      unlimited: { used: 7, total: 0, unlimited: true },
      broken: null, percent: { remainingPercentage: 42, resetAt: "not-a-date" },
      pack: { used: 2, total: 10, recurring: false, resetAt: "2026-09-13T10:00:00Z" },
    } });
    expect(rows.find(r => r.name === "unknown")).toMatchObject({ used: null, total: null, remainingPercentage: null });
    expect(rows.find(r => r.name === "credit").remainingPercentage).toBeCloseTo(34.8);
    expect(rows.find(r => r.name === "unlimited")).toMatchObject({ unlimited: true, remainingPercentage: null });
    expect(rows.find(r => r.name === "percent")).toMatchObject({ remainingPercentage: 42, resetAt: null });
    expect(rows.find(r => r.name === "pack").recurring).toBe(false);
    expect(rows.some(r => r.name === "broken")).toBe(false);
  });

  it("marks DeepSeek credit as an available currency balance, not a percentage quota", () => {
    const [credit] = quota.sanitizeQuotas({ quotas: {
      "Balance (USD)": { used: 0, total: 12.5, remainingPercentage: 100, isCreditBalance: true, currency: "USD", resetAt: "2026-09-13T10:00:00Z", secret: "private" },
    } });
    expect(credit).toMatchObject({ total: 12.5, isCreditBalance: true, currency: "USD", remainingPercentage: null, resetAt: null });
    expect(JSON.stringify(credit)).not.toContain("private");
    expect(quota.sanitizeQuotas({ quotas: { credit: { isCreditBalance: true, currency: "<unsafe>", total: 1 } } })[0].currency).toBeNull();
  });

  it("isolates provider failures and does not expose their messages", async () => {
    mocks.upstream.mockResolvedValue(Response.json({ error: "private-token private@example.com" }, { status: 500 }));
    const result = await quota.getPortalQuota();
    expect(result.accounts[0]).toMatchObject({ status: "unavailable", quotas: [] });
    expect(JSON.stringify(result)).not.toContain("private");
    await quota.getPortalQuota();
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("limits upstream concurrency to four across simultaneous viewers", async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 8 }, (_, index) => `account-${index}`);
    publish(ids.map(connectionId => ({ connectionId })));
    mocks.connections.mockResolvedValue(ids.map(id => connection(id)));
    const finish = [];
    let active = 0;
    let peak = 0;
    mocks.upstream.mockImplementation(() => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise(resolve => finish.push(() => { active -= 1; resolve(upstreamQuota()); }));
    });
    const first = quota.getPortalQuota();
    const second = quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.upstream).toHaveBeenCalledTimes(4);
    while (finish.length) {
      finish.splice(0).forEach(resolve => resolve());
      await vi.advanceTimersByTimeAsync(0);
    }
    const results = await Promise.all([first, second]);
    expect(peak).toBe(4);
    expect(mocks.upstream).toHaveBeenCalledTimes(8);
    expect(results[0].accounts).toHaveLength(8);
    expect(JSON.stringify(results[0])).not.toContain("private@example.com");
  });

  it("marks last good readings stale after failure and drops an account unpublished during refresh", async () => {
    vi.useFakeTimers();
    await quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(60_001);
    mocks.upstream.mockRejectedValueOnce(new Error("private error"));
    const stale = await quota.getPortalQuota();
    expect(stale.accounts[0]).toMatchObject({ status: "stale", quotas: [{ used: 25 }] });
    await vi.advanceTimersByTimeAsync(60_001);
    mocks.upstream.mockImplementationOnce(async () => { publish([]); return upstreamQuota(); });
    expect((await quota.getPortalQuota()).accounts).toEqual([]);
  });

  it("clears old readings when upstream explicitly returns an empty quota set", async () => {
    vi.useFakeTimers();
    await quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(60_001);
    mocks.upstream.mockResolvedValueOnce(Response.json({ quotas: {} }));
    expect((await quota.getPortalQuota()).accounts[0]).toMatchObject({ status: "unavailable", quotas: [] });
  });

  it("does not let four hung calls starve a healthy account, and never duplicates stalled calls", async () => {
    vi.useFakeTimers();
    const ids = ["hung-1", "hung-2", "hung-3", "hung-4", "healthy"];
    publish(ids.map(connectionId => ({ connectionId })));
    mocks.connections.mockResolvedValue(ids.map(id => connection(id)));
    const finish = [];
    mocks.upstream.mockImplementation(async (_request, context) => {
      const { connectionId } = await context.params;
      if (connectionId === "healthy") return upstreamQuota();
      return new Promise(resolve => finish.push(() => resolve(upstreamQuota())));
    });
    const pending = quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.accounts[4].status).toBe("available");
    expect(mocks.upstream).toHaveBeenCalledTimes(5);
    await quota.getPortalQuota();
    expect(mocks.upstream).toHaveBeenCalledTimes(5);
    finish.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(0);
  });

  it("caps retained stalled calls across publication changes and recovers when they settle", async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 100 }, (_, index) => `hung-${index}`);
    publish(ids.map(connectionId => ({ connectionId })));
    mocks.connections.mockResolvedValue(ids.map(id => connection(id)));
    const finish = [];
    mocks.upstream.mockImplementation(() => new Promise(resolve => finish.push(() => resolve(upstreamQuota()))));
    const initial = quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(260_000);
    await initial;
    expect(mocks.upstream).toHaveBeenCalledTimes(100);
    expect(quota.__test__.state.entries.size).toBe(100);
    publish([{ connectionId: "new-account" }]);
    mocks.connections.mockResolvedValue([connection("new-account")]);
    expect((await quota.getPortalQuota()).accounts[0].status).toBe("unavailable");
    expect(mocks.upstream).toHaveBeenCalledTimes(100);
    finish.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(0);
    mocks.upstream.mockImplementation(upstreamQuota);
    expect((await quota.getPortalQuota()).accounts[0].status).toBe("available");
    expect(quota.__test__.state.entries.size).toBe(1);
  });

  it("bounds a stalled request and retains in-flight coalescing without starting more work", async () => {
    vi.useFakeTimers();
    let finish;
    mocks.upstream.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).accounts[0].status).toBe("unavailable");
    const retry = quota.getPortalQuota();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await retry).accounts[0].status).toBe("unavailable");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    finish(upstreamQuota());
    await vi.advanceTimersByTimeAsync(0);
  });
});
