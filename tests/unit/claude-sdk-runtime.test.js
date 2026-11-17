import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSdkStatus, guardSdkEnvironment, resolveSdkExecutable, sdkRuntimeOptions } from "../../open-sse/executors/claude-sdk-runtime.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, LOCAL_PROVIDERS, OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";

beforeEach(() => {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) vi.stubEnv(key, "");
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/test/bundled claude");
});
afterEach(() => vi.unstubAllEnvs());

describe("local Claude runtime contract", () => {
  it("keeps cc routing local and removes old OAuth/billing identity", () => {
    expect(getExecutor("claude").constructor.name).toBe("ClaudeSdkExecutor");
    expect(PROVIDERS.claude).toEqual({ baseUrl: "claude-agent-sdk://local", format: "claude", noAuth: true, headers: {} });
    expect(PROVIDER_OAUTH.claude).toBeUndefined();
    expect(OAUTH_PROVIDERS.claude).toBeUndefined();
    expect(LOCAL_PROVIDERS.claude).toMatchObject({ alias: "cc", noAuth: true });
    expect(AI_PROVIDERS.claude).toBe(LOCAL_PROVIDERS.claude);
  });

  it("checks the exact execution binary with isolated settings and no credential output", async () => {
    const run = vi.fn(async (_, args) => args.includes("--version")
      ? { stdout: "2.1.test\n" }
      : { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "private@example.com" }) });
    const status = await checkSdkStatus(run);
    expect(status).toMatchObject({ ready: true, executable: resolveSdkExecutable(), version: "2.1.test" });
    expect(run.mock.calls.every(([binary]) => binary === resolveSdkExecutable())).toBe(true);
    expect(run.mock.calls[1][1]).toContain("--setting-sources");
    expect(run.mock.calls[1][2].env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("0");
    expect(JSON.stringify(status)).not.toContain("private@example.com");
  });

  it("parses logged-out status even when the official CLI exits with code 1", async () => {
    const run = vi.fn(async (_, args) => {
      if (args.includes("--version")) return { stdout: "2.1.test" };
      throw Object.assign(new Error("exit 1"), { stdout: '{"loggedIn":false,"authMethod":"none"}' });
    });
    expect(await checkSdkStatus(run)).toMatchObject({ ready: false, loginCommand: '"/test/bundled claude" auth login' });
  });

  it.each([
    { loggedIn: true, authMethod: "api_key" },
    { loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "2000-01-01T00:00:00Z" }
  ])("does not label API billing or expired login ready: %j", async (auth) => {
    const run = async (_, args) => ({ stdout: args.includes("--version") ? "2.1.test" : JSON.stringify(auth) });
    expect((await checkSdkStatus(run)).ready).toBe(false);
  });

  it("uses the same fail-closed environment guard for readiness and execution", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "false");
    const run = vi.fn();
    expect(() => guardSdkEnvironment()).toThrow(/ANTHROPIC_API_KEY/);
    expect(await checkSdkStatus(run)).toMatchObject({ ready: false, reason: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not inherit parent plugin, memory, cloud MCP or session context", () => {
    const options = sdkRuntimeOptions({ HOME: "/test", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_PLUGIN_DIRS: "/parent/plugins" });
    expect(options.env.HOME).toBe("/test");
    expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(options.env.CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined();
    expect(options.settings.autoMemoryEnabled).toBe(false);
    expect(options.settings.claudeMdExcludes).toContain("**/CLAUDE.md");
  });
});
