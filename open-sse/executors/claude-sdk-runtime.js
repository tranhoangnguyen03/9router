import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const CLOUD_ENV = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
let bundledExecutable;

export function guardSdkEnvironment(env = process.env) {
  const present = [...AUTH_ENV.filter((key) => !!env[key]), ...CLOUD_ENV.filter((key) => env[key] && !["0", "false"].includes(env[key]))];
  if (present.length) {
    throw Object.assign(new Error("Local Claude SDK cannot run with " + present.join(", ") + " set; remove conflicting authentication/provider values."), { status: 409 });
  }
}

export function resolveSdkExecutable() {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
  if (!bundledExecutable) {
    // Resolve from the app runtime, not a build-machine import.meta.url baked into webpack.
    const require = process.getBuiltinModule("module").createRequire(resolve(process.cwd(), "package.json"));
    const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
    bundledExecutable = require.resolve(pkg + (process.platform === "win32" ? "/claude.exe" : "/claude"));
  }
  return bundledExecutable;
}

export async function checkSdkStatus(run = exec) {
  try {
    guardSdkEnvironment();
    const executable = resolveSdkExecutable();
    const runtime = sdkRuntimeOptions();
    const options = { env: runtime.env, timeout: 6000, windowsHide: true, maxBuffer: 32768 };
    const version = await run(executable, ["--version"], options);
    const status = await run(executable, ["--setting-sources", "", "--settings", JSON.stringify(runtime.settings), "auth", "status", "--json"], options)
      .catch((error) => { if (error.stdout) return { stdout: error.stdout }; throw error; });
    const parsed = JSON.parse(status.stdout);
    const expired = parsed.loginExpiresAt && Date.parse(parsed.loginExpiresAt) <= Date.now();
    const ready = parsed.loggedIn === true && parsed.authMethod === "claude.ai" && !expired;
    return {
      ready,
      executable,
      loginCommand: JSON.stringify(executable) + " auth login",
      version: version.stdout.trim().slice(0, 120),
      ...(!ready ? { reason: expired ? "Claude Code login expired. Sign in again." : "Sign in to Claude Code with your own Claude account." } : {})
    };
  } catch (error) {
    return { ready: false, reason: error.status === 409 ? error.message : "Claude Code status failed. Check the executable, login, and app working directory." };
  }
}

// Isolate Claude Code's own agent features when used as a model backend.
// The caller owns prompts, tools, and context. No credentials are copied here.
const PARENT_SESSION_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID", "CLAUDE_EFFORT",
  "CLAUDE_ENV_FILE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"
];

const CONTEXT_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

export function sdkRuntimeOptions(parent = process.env) {
  const env = { ...parent };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  // A 9Router process launched from within Claude Code is a new, independent
  // session. It must not inherit the parent CLI's per-session markers.
  if (parent.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];

  return {
    env: {
      ...env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    },
    settings: {
      autoMemoryEnabled: false,
      claudeMdExcludes: [...CONTEXT_EXCLUDES],
      includeGitInstructions: false,
      outputStyle: "default"
    }
  };
}
