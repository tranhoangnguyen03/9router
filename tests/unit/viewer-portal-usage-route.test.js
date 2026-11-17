import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init = {}) => ({ body, status: init.status || 200, headers: init.headers })),
  cookies: vi.fn(),
  verify: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/viewerPortal/session", () => ({
  VIEWER_PORTAL_COOKIE: "9r_viewer_portal_session",
  verifyViewerPortalToken: mocks.verify,
}));
vi.mock("@/lib/viewerPortal/usage", () => ({
  PORTAL_PERIODS: new Set(["24h", "7d", "30d", "60d"]),
  getPortalUsage: mocks.getUsage,
}));

const { GET } = await import("@/app/api/viewer-portal/usage/route.js");

function request(period = "7d") {
  return { nextUrl: { searchParams: new URLSearchParams({ period }) } };
}

describe("viewer portal usage route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
    mocks.getUsage.mockResolvedValue({ period: "7d", summary: {} });
  });

  it("does not touch aggregate data for a locked viewer", async () => {
    mocks.verify.mockResolvedValue(false);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.getUsage).not.toHaveBeenCalled();
  });

  it("verifies authentication on every request, including cache hits", async () => {
    mocks.verify.mockResolvedValue(true);
    await GET(request());
    await GET(request());
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.getUsage).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported periods before aggregation", async () => {
    mocks.verify.mockResolvedValue(true);
    const response = await GET(request("all"));
    expect(response.status).toBe(400);
    expect(mocks.getUsage).not.toHaveBeenCalled();
  });
});
