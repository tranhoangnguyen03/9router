import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSdkExecutor } from "../../open-sse/executors/claude-sdk.js";
import { closeAllSdkToolSessions, getActiveSdkToolSessionCount } from "../../open-sse/executors/claude-sdk-tools.js";

afterEach(() => closeAllSdkToolSessions("test cleanup"));

const defs = [{ name: "calculate", description: "Calculate expressions", input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }];
const firstBody = () => ({ tools: defs, messages: [{ role: "user", content: "What is 6 times 7?" }] });
const resultBody = (id = "toolu_1", value = "42", toolDefs = defs) => ({
  tools: toolDefs,
  messages: [
    { role: "user", content: "What is 6 times 7?" },
    { role: "assistant", content: [{ type: "tool_use", id, name: "calculate", input: { expression: "6*7" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: value }] }
  ]
});

const frame = (event) => ({ type: "stream_event", parent_tool_use_id: null, event });
function fakeBridge() {
  let invoke;
  const mcpFactory = async (toolDefs, handleCall) => {
    invoke = handleCall;
    return {
      allowedTools: toolDefs.map((def) => "mcp__router__" + def.name),
      mcpServers: { router: { type: "sdk", name: "router", instance: {} } },
      close: vi.fn()
    };
  };
  const requests = [];
  const queryFactory = (args) => {
    requests.push(args);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "test-session" };
      yield frame({ type: "message_start", message: { id: "msg_first", model: args.options.model, usage: { input_tokens: 5 } } });
      yield frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__router__t0", input: { expression: "6*7" } } });
      yield frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } });
      yield frame({ type: "message_stop" });
      const result = await invoke("toolu_1", "t0");
      yield frame({ type: "message_start", message: { id: "msg_second", model: args.options.model, usage: { input_tokens: 7 } } });
      yield frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      yield frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The result is " + result.content[0].text } });
      yield frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } });
      yield frame({ type: "message_stop" });
      yield { type: "result", subtype: "success", is_error: false };
    })();
  };
  return { mcpFactory, queryFactory, requests };
}

describe("Claude Agent SDK external tool boundary", () => {
  it("returns a client-owned tool_use and resumes the SAME SDK query after result", async () => {
    const f = fakeBridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const first = (await executor.execute({ model: "claude-test", body: firstBody(), stream: false })).response;
    expect(first.status).toBe(200);
    const message = await first.json();
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "calculate", input: { expression: "6*7" } }]);
    expect(getActiveSdkToolSessionCount()).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].options.tools).toEqual([]);
    expect(f.requests[0].options.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("0");
    expect(f.requests[0].options.settings.autoMemoryEnabled).toBe(false);
    expect(f.requests[0].options.allowedTools).toEqual(["mcp__router__t0"]);

    // Here the client executes calculate. 9Router never executes it.
    const next = (await executor.execute({ model: "claude-test", body: resultBody(), stream: false })).response;
    expect(next.status).toBe(200);
    const reply = await next.json();
    expect(reply.content).toEqual([{ type: "text", text: "The result is 42" }]);
    expect(reply.stop_reason).toBe("end_turn");
    expect(f.requests).toHaveLength(1); // no second query, so no hidden tool replay
  });

  it("supports SSE on the tool-use turn and JSON on the resumed turn", async () => {
    const f = fakeBridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const first = (await executor.execute({ model: "claude-test", body: firstBody(), stream: true })).response;
    const events = await first.text();
    expect(events).toContain("event: message_start");
    expect(events).toContain('"name":"calculate"');
    expect(events).toContain("event: message_stop");

    const next = (await executor.execute({ model: "claude-test", body: resultBody(), stream: false })).response;
    expect((await next.json()).content[0].text).toBe("The result is 42");
  });

  it("rejects missing, mismatched, or repeated tool results without replaying the query", async () => {
    const f = fakeBridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    await (await executor.execute({ model: "claude-test", body: firstBody(), stream: false })).response.json();
    const badId = (await executor.execute({ model: "claude-test", body: resultBody("wrong_id"), stream: false })).response;
    expect(badId.status).toBe(409);
    const badModel = (await executor.execute({ model: "different-model", body: resultBody(), stream: false })).response;
    expect(badModel.status).toBe(409);
    const valid = (await executor.execute({ model: "claude-test", body: resultBody(), stream: false })).response;
    expect(valid.status).toBe(200);
    await valid.json();
    const duplicate = (await executor.execute({ model: "claude-test", body: resultBody(), stream: false })).response;
    expect(duplicate.status).toBe(409);
    expect(f.requests).toHaveLength(1);
  });

  it("rejects changed tool schemas while waiting for client execution", async () => {
    const f = fakeBridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    await (await executor.execute({ model: "claude-test", body: firstBody(), stream: false })).response.json();
    const incompatible = [{ name: "calculate", input_schema: { type: "object", properties: { dangerous: { type: "boolean" } } } }];
    const response = (await executor.execute({ model: "claude-test", body: resultBody("toolu_1", "42", incompatible), stream: false })).response;
    expect(response.status).toBe(409);
    const valid = (await executor.execute({ model: "claude-test", body: resultBody(), stream: false })).response;
    expect(valid.status).toBe(200);
    await valid.json();
  });

  it("fails closed for unsupported tool schema, with no SDK invocation", async () => {
    const f = fakeBridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const malformed = { messages: [{ role: "user", content: "Test" }], tools: [{ name: "bad", input_schema: { type: "array", items: {} } }] };
    const response = (await executor.execute({ model: "claude-test", body: malformed, stream: false })).response;
    expect(response.status).toBe(422);
    expect(f.requests).toHaveLength(0);
  });

  it("forbids the cloud-key fallback even when client tools are present", async () => {
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "synthetic-test-token";
    try {
      const f = fakeBridge();
      const response = (await new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory)
        .execute({ model: "claude-test", body: firstBody(), stream: false })).response;
      expect(response.status).toBe(409);
      expect(f.requests).toHaveLength(0);
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = old;
    }
  });
});
