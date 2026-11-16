# Claude Code Agent SDK backend

This fork **replaces** the old `cc/...` Claude provider's direct HTTP/OAuth routing with a **local official Claude Code process** started through `@anthropic-ai/claude-agent-sdk`.

## Setup

1. Run 9Router on a local machine or a persistent self-hosted Node.js server. This backend is not supported in serverless deployments.
2. Install the official Claude Code CLI, then run `claude auth login` as the **same operating-system user** running 9Router.
3. Open **Providers → Claude Code (local SDK)** to inspect login status. The SDK uses its bundled official CLI by default. To force a known installed binary, set `CLAUDE_CODE_EXECUTABLE` to the full path of that executable before starting 9Router.
4. Use existing `cc/<model-id>` IDs. The `claude` provider is now local and has no 9Router OAuth account/connection rows. Legacy OAuth rows in an existing database are ignored (not silently deleted); remove them separately if desired.

This provider does not read, store, or refresh Claude Code OAuth credentials. It does not forge headers, alter upstream requests, copy session tokens, or silently fall back to paid API keys. It fails if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or cloud-provider selector variables are set. Authentication and billing are owned by Claude Code / Anthropic. Included subscription quota is **not guaranteed**: verify account usage and Anthropic's current rules for this specific setup before use.

## Compatibility and current limits

| Feature | Status |
| --- | --- |
| Replace direct Claude HTTP/OAuth provider and preserve `cc/` routing | Implemented |
| Local unmodified Claude Code executable and its own login | Implemented, requires local live acceptance |
| Single-turn text, Claude Messages JSON, streaming SSE | Implemented, offline tests added |
| Multi-turn text context | Converted to quoted prior transcript in each request; **not** a native Claude Code session replay |
| Client-owned tool use and tool results | **In-memory SDK MCP bridge implemented; live acceptance pending.** 9Router returns tool calls and waits for client results without executing them |
| Images, audio, non-text message content | Rejected with 422 |
| Temperature, top-p, stop sequences, structured output | Rejected with 422 where supplied |
| Exact `max_tokens` control | SDK has no equivalent per-query Messages API option. Not enforced by the adapter |
| Thinking disabled | Rejected; no false translation to low effort |
| SDK version, model, login compatibility | Local validation required |
| Hosted/multi-user subscription routing | Not supported |

**Important:** This is *not yet a validated full drop-in Messages API replacement*. Tool use is implemented with an in-memory SDK MCP bridge, but it must pass real Pi/Claude live acceptance before release. After a router restart or 120 seconds without results, the bridge rejects stale results with HTTP 409 instead of replaying a client tool. Multi-turn sessions outside a pending tool call still use quoted history, not native session replay.

## Developer acceptance

Run the offline test suite from the project's test setup:

```sh
cd tests
npm install
npm test -- claude-sdk.test.js claude-sdk-tools.test.js
```

Then run local live checks: check login, one text JSON turn, one SSE turn, real client tool calls and results (sequential and parallel), repeated turns, restart in a pending tool call, client abort, missing CLI, expired login, conflicting environment variables, and account usage/billing category. Confirm no upstream API key or OAuth token is sent by 9Router. Verify no client tool runs in the 9Router process.

Reference implementation to study for full Pi tool/session parity: [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) (especially `src/mcp-server.ts`, `src/session-sync.ts`, `src/index.ts`). Reproducing those semantics in a stateless HTTP router needs careful state and timeout handling.

## Policy note

Anthropic's documentation draws a distinction between users of the unmodified Claude Code CLI and third-party products routing subscription credentials. Local technical success does not prove terms approval or subscription billing. See [Anthropic legal guidance](https://code.claude.com/docs/en/legal-and-compliance).
