import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), quota: vi.fn(), accounts: vi.fn(), update: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "viewer-token" }) }) }));
vi.mock("@/lib/viewerPortal/session", () => ({ VIEWER_PORTAL_COOKIE: "9r_viewer_portal_session", verifyViewerPortalToken: mocks.verify }));
vi.mock("@/lib/viewerPortal/quota", () => ({ getPortalQuota: mocks.quota, getQuotaAccounts: mocks.accounts }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/db/driver", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/viewerPortal/config", async (importOriginal) => ({ ...(await importOriginal()), updateViewerPortalConfig: mocks.update }));
const viewer = await import("@/app/api/viewer-portal/usage/quota/route.js");
const admin = await import("@/app/api/viewer-portal/admin/quota/route.js");

describe("portal quota API boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue(true);
    mocks.quota.mockResolvedValue({ accounts: [] });
    mocks.accounts.mockResolvedValue([{ id: "one", name: "Admin name", provider: "codex", isActive: true }]);
    mocks.update.mockImplementation(async transform => transform({ groups: [{ id: "usage" }], quotaAccounts: [], passwordHash: "secret" }));
  });
  it("authenticates before every read, including cached responses, and uses no-store", async () => {
    for (let i = 0; i < 2; i++) expect((await viewer.GET()).headers.get("Cache-Control")).toBe("no-store");
    mocks.verify.mockResolvedValue(false);
    const locked = await viewer.GET();
    expect(locked.status).toBe(401);
    expect(locked.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.quota).toHaveBeenCalledTimes(2);
  });
  it("rejects sessions revoked during a slow refresh", async () => {
    mocks.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await viewer.GET()).status).toBe(401);
  });
  it("never exposes internal retrieval errors", async () => {
    mocks.quota.mockRejectedValue(new Error("secret database error"));
    const response = await viewer.GET();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("saves quota selection without changing usage groups or returning the password", async () => {
    const response = await admin.PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ quotaAccounts: [{ connectionId: "one", label: "Public" }] }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.portal.quotaAccounts).toEqual([{ connectionId: "one", label: "Public" }]);
    expect(body.portal.groups[0].id).toBe("usage");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("rejects stale/invalid selections before writing", async () => {
    const response = await admin.PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ quotaAccounts: [{ connectionId: "missing" }] }) }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
