import { afterEach, expect, it, vi } from "vitest";

const { row } = vi.hoisted(() => ({ row: { id: "old-claude", provider: "claude", authType: "oauth", isActive: true, accessToken: "legacy-secret", refreshToken: "legacy-refresh", providerSpecificData: { prefix: "old-prefix", enabledModels: ["old-only"] } } }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(async () => row),
  getProviderConnections: vi.fn(async () => [row]),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: vi.fn(), filterModelsListForKey: vi.fn((list) => list) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));

import { getProviderCredentials } from "../../src/sse/services/auth.js";
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { GET, refreshAndUpdateCredentials } from "../../src/app/api/usage/[connectionId]/route.js";
import { POST as reset } from "../../src/app/api/usage/[connectionId]/claude-reset/route.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { buildModelsList } from "../../src/app/api/v1/models/route.js";
import { refreshClaudeOAuthToken } from "../../open-sse/services/tokenRefresh/providers.js";

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it("selects virtual local credentials instead of querying legacy rows", async () => {
  const credentials = await getProviderCredentials("cc");
  expect(credentials).toMatchObject({ connectionId: "noauth", connectionName: "Local Claude Code" });
  expect(credentials.accessToken).toBeUndefined();
  expect(getProviderConnections).not.toHaveBeenCalled();
});
it("keeps legacy tokens out of quota, refresh and reset paths", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call network"));
  const response = await GET(new Request("http://local/api/usage/old-claude"), { params: Promise.resolve({ connectionId: row.id }) });
  expect(await response.json()).toMatchObject({ message: expect.stringContaining("local Claude Code") });
  expect(getUsageForProvider).not.toHaveBeenCalled();
  expect(await refreshAndUpdateCredentials(row, true)).toEqual({ connection: row, refreshed: false });
  expect(await refreshClaudeOAuthToken(row.refreshToken)).toBeNull();
  expect((await reset()).status).toBe(410);
  expect(fetch).not.toHaveBeenCalled();
  expect(updateProviderConnection).not.toHaveBeenCalled();
});
it("replaces legacy model restrictions/prefixes with the virtual cc catalog", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const models = await buildModelsList(["llm"]);
  expect(models.some((m) => m.id === "cc/claude-fable-5-2")).toBe(true);
  expect(models.some((m) => m.id.includes("old-prefix") || m.id.includes("old-only"))).toBe(false);
});
