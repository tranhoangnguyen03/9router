import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init = {}) => ({ body, status: init.status || 200 })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(), genSalt: vi.fn(), hash: vi.fn() } }));

const settingsRoute = await import("@/app/api/settings/route.js");

function storedSettings() {
  return {
    requireLogin: true,
    cloudEnabled: false,
    password: "dashboard-hash",
    forkExtensions: {
      viewerPortal: { passwordHash: "viewer-hash", draftBoard: { body: "private draft" } },
    },
  };
}

describe("generic settings API fork boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(storedSettings());
    mocks.updateSettings.mockResolvedValue(storedSettings());
  });

  it("does not return the fork settings namespace", async () => {
    const response = await settingsRoute.GET();
    expect(response.body).not.toHaveProperty("forkExtensions");
    expect(JSON.stringify(response.body)).not.toContain("viewer-hash");
    expect(JSON.stringify(response.body)).not.toContain("private draft");
  });

  it("does not allow the generic PATCH route to overwrite fork settings", async () => {
    const request = {
      json: vi.fn(async () => ({
        cloudEnabled: true,
        forkExtensions: { viewerPortal: { passwordHash: "attacker-value" } },
      })),
    };
    await settingsRoute.PATCH(request);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ cloudEnabled: true });
  });
});
