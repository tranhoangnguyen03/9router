import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy } = await import("@/dashboardGuard.js");

function request(pathname) {
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    headers: new Headers(),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

describe("viewer portal guard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it.each([
    "/api/viewer-portal/public",
    "/api/viewer-portal/session",
    "/api/viewer-portal/session/status",
    "/api/viewer-portal/usage",
    "/api/viewer-portal/usage/quota",
  ])("allows the viewer route to perform its own access checks: %s", async (pathname) => {
    expect(await proxy(request(pathname))).toBe(mocks.nextResponse);
  });

  it.each(["/api/viewer-portal/admin", "/api/viewer-portal/admin/quota"])("keeps fork portal administration behind dashboard authentication: %s", async (pathname) => {
    const response = await proxy(request(pathname));
    expect(response.status).toBe(401);
  });
});
