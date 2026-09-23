import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), usage: vi.fn(), refresh: vi.fn(), proxy: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ forkExtensions: { viewerPortal: { enabled: true, passwordHash: "hash", quotaAccounts: [{ connectionId: "selected", label: "Shared" }] } } }),
  getProviderConnections: async () => [await mocks.get()],
  getProviderConnectionById: mocks.get,
  updateProviderConnection: mocks.update,
}));
vi.mock("@/lib/db/driver", () => ({ getAdapter: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.usage }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({ needsRefresh: () => true, refreshCredentials: mocks.refresh }) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
const { getPortalQuota } = await import("@/lib/viewerPortal/quota.js");

it("uses the real upstream handler for proxy resolution and persisted OAuth refresh, without forced polling", async () => {
  mocks.get.mockResolvedValue({ id: "selected", name: "private@example.com", provider: "codex", authType: "oauth", isActive: true, accessToken: "old-secret", refreshToken: "refresh-secret", providerSpecificData: { connectionProxyEnabled: true } });
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080" });
  mocks.refresh.mockResolvedValue({ accessToken: "new-secret", expiresIn: 3600 });
  mocks.usage.mockResolvedValue({ quotas: { session: { used: 40, total: 100 } } });
  const result = await getPortalQuota();
  expect(mocks.get).toHaveBeenCalledWith("selected");
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.update).toHaveBeenCalledWith("selected", expect.objectContaining({ accessToken: "new-secret" }));
  expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "new-secret" }), expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080", strictProxy: false }), { force: false });
  expect(result.accounts[0].quotas[0].remainingPercentage).toBe(60);
  expect(JSON.stringify(result)).not.toMatch(/secret|private|selected|proxy.example/);
});
