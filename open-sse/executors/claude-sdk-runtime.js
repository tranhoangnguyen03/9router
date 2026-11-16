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
