export default {
  id: "claude",
  priority: 10,
  alias: "cc",
  uiAlias: "cc",
  display: {
    name: "Claude Code (local SDK)",
    icon: "smart_toy",
    color: "#D97757",
    website: "https://code.claude.com",
    notice: {
      text: "Runs the official Claude Code binary through the Agent SDK. Sign in locally; 9Router does not store subscription credentials. Anthropic determines usage and billing.",
    },
  },
  category: "local",
  noAuth: true,
  transport: {
    baseUrl: "claude-agent-sdk://local",
    format: "claude",
    noAuth: true,
    headers: {},
  },
  models: [
    { id: "claude-fable-5-2", name: "Claude Fable 5.2" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
};
