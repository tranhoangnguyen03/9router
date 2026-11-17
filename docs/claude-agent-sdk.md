# Local Claude Code backend

The existing `claude` provider and `cc/<model-id>` routes now run an unmodified official Claude Code process through `@anthropic-ai/claude-agent-sdk` (pinned to 0.3.321). They no longer use direct subscription OAuth Messages requests or identity-cloaking headers. Other Anthropic-compatible providers are unchanged.

## Setup

1. Run 9Router from its app directory on a persistent Node.js host. Serverless and multiple router processes are not supported for this backend.
2. Open **Providers → Local Providers → Claude Code (local SDK)**. The status card checks the *same executable and isolated environment* used for execution, and shows its exact login command. By default this is the SDK's bundled binary, not an unrelated `claude` in PATH.
3. Run that command as the router's OS user with the same `HOME` / `CLAUDE_CONFIG_DIR`. `CLAUDE_CODE_EXECUTABLE` can select a different unmodified official binary. Its version must support the pinned SDK's options.
4. Use the existing `cc/<model-id>` names and normal `/v1/messages`, `/v1/chat/completions`, or streaming `/v1/responses` endpoints.

For Docker, run the login command **inside the container as `node`**. Persist that user's Claude configuration directory (normally `/home/node/.claude`) separately from `/app/data` if login must survive container replacement. Do not copy subscription tokens into 9Router's database.

Readiness is a local CLI login check, not proof that a model request will succeed or be included in a subscription. Expired logins, API-key auth, and conflicting environment variables are not labeled ready.

## Authentication and isolation

Claude Code owns login, token storage, refresh, and billing. The router does not import those credentials. Existing 9Router Claude OAuth rows are retained for explicit user cleanup but ignored by routing, model selection, background refresh, quota auto-ping, and usage checks. Legacy OAuth and limit-reset endpoints return 410.

Local execution refuses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or enabled Bedrock/Vertex/Foundry selector variables. Remove those conflicts from the **router process**, rather than expecting a silent fallback to API billing. Other providers remain available through their own connections.

Child processes disable built-in tools, filesystem settings, skills, cloud MCP servers, auto-memory, auto-compaction, and project context files. Parent CLI session markers and plugin directories are not inherited. Client tools are exposed through an in-process MCP bridge: the router only hands calls and results between Claude and the client; it does not execute the client tools.

## Compatibility contract

| Feature | Current behavior |
| --- | --- |
| Text, text system blocks, JSON and SSE | Supported |
| Client tools and results | Sequential and parallel calls continue the **same SDK query**; results are paired by tool-use ID, including out-of-order MCP dispatch |
| Claude / OpenAI result batches | Consecutive result messages are read as one batch; all outstanding IDs must be provided exactly once |
| Completed-assistant fallback | Emits normal text and tool-input deltas; late completed copies of streamed messages are ignored |
| SDK failure / cancellation | JSON errors or SSE error events; final success waits for the SDK result; cancellation aborts and releases the session |
| Thinking | `disabled`, `adaptive`, or `enabled` with a positive `budget_tokens`, mapped to native SDK options |
| Effort | `reasoning_effort` or `output_config.effort`: low, medium, high, xhigh, max |
| Unsupported controls | Sampling, stop sequences, structured output, forced tool choice, metadata and service tier fail with 422, with or without tools |
| Images/audio/documents and non-text tool results | Unsupported; rejected |
| Root tool-schema anyOf/oneOf/allOf | Rejected explicitly; nested JSON Schema is preserved |
| `max_tokens` | Not enforced as an exact Messages API limit |
| Ordinary conversation history | Quoted transcript on a new query, **not native session replay** |
| Pending tool session | In memory; expires after 120 seconds waiting for results; cap of 12 active tool sessions |

After expiry, router restart, changed model/tool schemas, missing IDs or duplicate results, the bridge returns 409 rather than replaying client tools. Do not retry a side-effecting tool automatically. A successful native session-history implementation (including edited history/forks) is still needed before claiming full Messages API parity.

## Verification

```sh
npm ci
npm ci --prefix tests
cd tests
npx vitest run unit/claude-sdk*.test.js unit/background-token-refresh.test.js unit/quota-auto-ping.test.js
```

The tests cover translated parallel results, sequential rounds, completed-message fallback, cancellation, expiry, SDK errors, request controls, readiness and legacy-token isolation. Protocol integration tests use the **real SDK and real MCP transport** with an offline CLI fixture. They require no account and do not establish live model compatibility.

CI also builds the standalone server and checks the packaged native binary and missing-login behavior. Builds/tests must use a temporary `DATA_DIR` (and an isolated `HOME` for live CLI checks); never point acceptance runs at production data.

Before release, complete real local acceptance with your own login: one JSON request, SSE, sequential/parallel client tools, repeated turns, abort, slow reader, expiry/restart, and account usage/billing category. No successful live subscription run is claimed by offline tests.

## Policy and billing

An official SDK and unmodified binary do not by themselves establish permission or billing treatment for a particular router deployment. Anthropic distinguishes an end user signing into their own unmodified binary from third-party subscription routing on users' behalf. See [authentication and credential guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). Hosted/shared-subscription routing is outside this feature's scope.
