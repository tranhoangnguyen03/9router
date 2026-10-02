import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((callback) => callback()),
}));

vi.mock("uuid", () => ({ v4: vi.fn(() => "generated-group-id") }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/driver", () => ({
  getAdapter: vi.fn(async () => ({ get: mocks.get, run: mocks.run, transaction: mocks.transaction })),
}));

const {
  normalizePortalConfig,
  toAdminPortalConfig,
  updateViewerPortalConfig,
  validateAndNormalizeGroups,
} = await import("@/lib/viewerPortal/config.js");

describe("viewer portal configuration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps an API key in only the first configured group", () => {
    const portal = normalizePortalConfig({
      groups: [
        { id: "one", name: "One", apiKeyIds: ["key-a"] },
        { id: "two", name: "Two", apiKeyIds: ["key-a", "key-b"] },
      ],
    });
    expect(portal.groups[0].apiKeyIds).toEqual(["key-a"]);
    expect(portal.groups[1].apiKeyIds).toEqual(["key-b"]);
  });

  it("rejects duplicate assignments on admin writes", () => {
    expect(() => validateAndNormalizeGroups([
      { id: "one", name: "One", apiKeyIds: ["key-a"] },
      { id: "two", name: "Two", apiKeyIds: ["key-a"] },
    ], new Set(["key-a"]))).toThrow("only one published group");
  });

  it("never returns the viewer password hash to administrators", () => {
    const result = toAdminPortalConfig({ passwordHash: "bcrypt-secret", groups: [] });
    expect(result.hasPassword).toBe(true);
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("authVersion");
    expect(JSON.stringify(result)).not.toContain("bcrypt-secret");
  });

  it("moves pre-namespace settings into forkExtensions on the next write", async () => {
    mocks.get.mockReturnValue({
      data: JSON.stringify({ viewerPortal: { enabled: true, title: "Legacy" }, unrelated: "preserved" }),
    });

    await updateViewerPortalConfig((portal) => ({ ...portal, title: "Namespaced" }));

    const stored = JSON.parse(mocks.run.mock.calls[0][1][0]);
    expect(stored.unrelated).toBe("preserved");
    expect(stored).not.toHaveProperty("viewerPortal");
    expect(stored.forkExtensions.viewerPortal.title).toBe("Namespaced");
  });
});
