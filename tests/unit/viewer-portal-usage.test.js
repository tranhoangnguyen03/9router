import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  all: vi.fn(),
  getApiKeys: vi.fn(),
  getViewerPortalConfig: vi.fn(),
  getCachedPortalUsage: vi.fn((_key, compute) => compute()),
}));

vi.mock("@/lib/db/driver", () => ({ getAdapter: vi.fn(async () => ({ all: mocks.all })) }));
vi.mock("@/lib/localDb", () => ({ getApiKeys: mocks.getApiKeys, getProviderNodes: vi.fn(async () => []) }));
vi.mock("@/lib/viewerPortal/config.js", () => ({ getViewerPortalConfig: mocks.getViewerPortalConfig }));
vi.mock("@/lib/viewerPortal/cache.js", () => ({ getCachedPortalUsage: mocks.getCachedPortalUsage }));

const { getPortalUsage } = await import("@/lib/viewerPortal/usage.js");

describe("viewer portal published-key aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    mocks.getApiKeys.mockResolvedValue([
      { id: "published-id", key: "sk-published-secret", name: "Product", isActive: true },
      { id: "private-id", key: "sk-private-secret", name: "Private", isActive: true },
    ]);
    mocks.getViewerPortalConfig.mockResolvedValue({
      groups: [{ id: "group-1", name: "Product team", apiKeyIds: ["published-id"] }],
    });
  });

  afterEach(() => vi.useRealTimers());

  it("excludes private keys and strips raw key values from the response", async () => {
    mocks.all.mockImplementation((sql) => {
      if (sql.includes("usageDaily")) {
        return [{
          dateKey: "2026-08-22",
          data: JSON.stringify({
            byApiKey: {
              published: { apiKey: "sk-published-secret", rawModel: "gpt-5", provider: "openai", requests: 2, promptTokens: 100, completionTokens: 40, cachedTokens: 25, cost: 0.02 },
              private: { apiKey: "sk-private-secret", rawModel: "gpt-5", provider: "openai", requests: 99, promptTokens: 9_999, completionTokens: 9_999, cachedTokens: 0, cost: 9.99 },
            },
          }),
        }];
      }
      if (sql.includes("usageHistory")) return [{ timestamp: "2026-08-22T11:30:00.000Z", apiKey: "sk-published-secret" }];
      return [];
    });

    const result = await getPortalUsage("7d");

    expect(result.summary.requests).toBe(2);
    expect(result.summary.inputTokens).toBe(100);
    expect(result.groups[0].keys).toEqual([expect.objectContaining({ id: "published-id", name: "Product", requests: 2 })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-published-secret");
    expect(serialized).not.toContain("sk-private-secret");
    expect(serialized).not.toContain("Private");
  });

  it("reads only the latest history timestamp per published key for long periods", async () => {
    mocks.all.mockImplementation((sql) => {
      if (sql.includes("usageDaily")) return [];
      if (sql.includes("GROUP BY apiKey")) return [{ apiKey: "sk-published-secret", timestamp: "2026-08-22T11:30:00.000Z" }];
      return [];
    });

    const result = await getPortalUsage("60d");
    expect(result.groups[0].keys[0].lastUsed).toBe("2026-08-22T11:30:00.000Z");
    const [sql] = mocks.all.mock.calls.find(([query]) => query.includes("usageHistory"));
    expect(sql).toContain("MAX(timestamp) AS timestamp");
    expect(sql).toContain("GROUP BY apiKey");
  });

  it("changes the cache fingerprint when selected key metadata changes", async () => {
    mocks.all.mockReturnValue([]);
    await getPortalUsage("24h");
    const firstKey = mocks.getCachedPortalUsage.mock.calls[0][0];

    mocks.getApiKeys.mockResolvedValue([
      { id: "published-id", key: "sk-published-secret", name: "Renamed", isActive: false },
      { id: "private-id", key: "sk-private-secret", name: "Private", isActive: true },
    ]);
    await getPortalUsage("24h");
    const secondKey = mocks.getCachedPortalUsage.mock.calls[1][0];

    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).not.toContain("sk-published-secret");
  });
});
