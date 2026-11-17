import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { ClaudeSdkExecutor } from "../../open-sse/executors/claude-sdk.js";
import { closeAllSdkToolSessions, getActiveSdkToolSessionCount } from "../../open-sse/executors/claude-sdk-tools.js";

beforeEach(() => {
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", fileURLToPath(new URL("../fixtures/claude-sdk-cli.cjs", import.meta.url)));
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) vi.stubEnv(key, "");
});
afterEach(() => { closeAllSdkToolSessions(); vi.unstubAllEnvs(); });

it.each([false, true])("runs real SDK subprocess + MCP parallel handoff without an account (stream=%s)", async (stream) => {
  const executor = new ClaudeSdkExecutor();
  const body = { system: "Offline test", tools: [{ name: "calculate", input_schema: { type: "object", properties: { expression: { type: "string" } } } }], messages: [{ role: "user", content: "parallel" }] };
  const first = (await executor.execute({ model: "claude-test", body, stream })).response;
  expect(first.status, first.ok ? "" : await first.clone().text()).toBe(200);
  let content;
  if (stream) {
    const text = await first.text();
    content = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).filter((e) => e.type === "content_block_start").map((e) => e.content_block);
  } else content = (await first.json()).content;
  expect(content.map((b) => b.name)).toEqual(["calculate", "calculate"]);
  body.messages.push({ role: "assistant", content }, { role: "user", content: content.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: b.id })) });
  const next = (await executor.execute({ model: "claude-test", body, stream: false })).response;
  expect(next.status).toBe(200);
  expect((await next.json()).content[0].text).toContain("toolu_0");
  await vi.waitFor(() => expect(getActiveSdkToolSessionCount()).toBe(0));
}, 15000);

it("runs real SDK no-tool response adaptation without an account", async () => {
  const response = (await new ClaudeSdkExecutor().execute({ model: "claude-test", body: { messages: [{ role: "user", content: "hello" }] }, stream: false })).response;
  expect(response.status, response.ok ? "" : await response.clone().text()).toBe(200);
  expect((await response.json()).content[0].text).toBe("Offline OK");
}, 15000);
