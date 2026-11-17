import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init = {}) => ({ body, status: init.status || 200 })),
  getAdapter: vi.fn(),
  killAppProcesses: vi.fn(),
  spawnUpdaterAndExit: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/appUpdater", () => ({
  killAppProcesses: mocks.killAppProcesses,
  spawnUpdaterAndExit: mocks.spawnUpdaterAndExit,
}));

const healthRoute = await import("@/app/api/health/route.js");
const versionRoute = await import("@/app/api/version/route.js");
const updateRoute = await import("@/app/api/version/update/route.js");
const shutdownRoute = await import("@/app/api/version/shutdown/route.js");

const originalManaged = process.env.NINEROUTER_MANAGED_DEPLOYMENT;
const originalNodeEnv = process.env.NODE_ENV;

describe("managed deployment boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NINEROUTER_MANAGED_DEPLOYMENT;
    process.env.NODE_ENV = "production";
    mocks.getAdapter.mockResolvedValue({ get: vi.fn(() => ({ ok: 1 })) });
  });

  afterEach(() => {
    if (originalManaged === undefined) delete process.env.NINEROUTER_MANAGED_DEPLOYMENT;
    else process.env.NINEROUTER_MANAGED_DEPLOYMENT = originalManaged;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("reports ready only after opening and querying the database", async () => {
    const response = await healthRoute.GET();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(mocks.getAdapter).toHaveBeenCalledOnce();
  });

  it("returns 503 when the database is unavailable", async () => {
    mocks.getAdapter.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await healthRoute.GET();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false });
  });

  it("does not advertise the official npm package in managed mode", async () => {
    process.env.NINEROUTER_MANAGED_DEPLOYMENT = "true";
    const response = await versionRoute.GET();
    expect(await response.json()).toMatchObject({ managedDeployment: true, hasUpdate: false });
  });

  it("rejects the npm updater in managed mode", async () => {
    process.env.NINEROUTER_MANAGED_DEPLOYMENT = "true";
    const response = await updateRoute.POST();
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ managedDeployment: true });
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
    expect(mocks.spawnUpdaterAndExit).not.toHaveBeenCalled();
  });

  it("rejects dashboard shutdown in managed mode", async () => {
    process.env.NINEROUTER_MANAGED_DEPLOYMENT = "true";
    const response = await shutdownRoute.POST();
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ managedDeployment: true });
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
  });
});
