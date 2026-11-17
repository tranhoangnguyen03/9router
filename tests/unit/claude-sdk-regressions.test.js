import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSdkExecutor, eventsFromCompletedAssistant } from "../../open-sse/executors/claude-sdk.js";
import { closeAllSdkToolSessions, getActiveSdkToolSessionCount } from "../../open-sse/executors/claude-sdk-tools.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";

const defs = [{ name: "calculate", input_schema: { type: "object", properties: { expression: { type: "string" } } } }];
const initial = () => ({ system: "Client system", tools: defs, messages: [{ role: "user", content: "Calculate" }] });
const frame = (event) => ({ type: "stream_event", parent_tool_use_id: null, event });
const assistant = (content, stop_reason = "end_turn") => ({
  type: "assistant", parent_tool_use_id: null,
  message: { id: "msg_test", model: "claude-test", content, stop_reason, usage: { input_tokens: 3, output_tokens: 1 } }
});

function bridge({ ids = ["toolu_1"], rounds = 1, fallback = false, failure = false } = {}) {
  let invoke;
  const requests = [];
  const results = [];
  const mcpFactory = async (_, handle) => {
    invoke = handle;
    return { allowedTools: ["mcp__router__t0"], mcpServers: {}, close: vi.fn() };
  };
  const queryFactory = (args) => {
    requests.push(args);
    return (async function* () {
      for (let round = 0; round < rounds; round++) {
        const calls = ids.map((id) => ({ type: "tool_use", id: id + (round ? "_" + round : ""), name: "mcp__router__t0", input: { expression: "6*7" } }));
        const message = assistant(calls, "tool_use");
        if (fallback) yield message;
        else for (const event of eventsFromCompletedAssistant(message, "claude-test")) yield frame(event);
        // Dispatch in reverse order to ensure pairing uses IDs, never arrival order.
        results.push(...await Promise.all(calls.toReversed().map((call) => invoke(call.id, "t0"))));
      }
      const final = assistant([{ type: "text", text: "Finished" }]);
      if (fallback) yield final;
      else for (const event of eventsFromCompletedAssistant(final, "claude-test")) yield frame(event);
      yield failure ? { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Hit max turns"] } : { type: "result", subtype: "success" };
    })();
  };
  return { queryFactory, mcpFactory, requests, results };
}
const execute = (executor, body, stream = false, signal) => executor.execute({ model: "claude-test", body, stream, signal }).then((result) => result.response);
function appendResults(body, reply) {
  body.messages.push({ role: "assistant", content: reply.content });
  body.messages.push({ role: "user", content: reply.content.filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: b.id })) });
}
afterEach(() => { closeAllSdkToolSessions(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Claude SDK review regressions", () => {
  it.each([false, true])("resumes sequential and parallel calls in one query (fallback=%s)", async (fallback) => {
    const f = bridge({ ids: ["toolu_1", "toolu_2"], rounds: 2, fallback });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const body = initial();
    for (let round = 0; round < 2; round++) {
      const response = await execute(executor, body);
      expect(response.status).toBe(200);
      const reply = await response.json();
      expect(reply.stop_reason).toBe("tool_use");
      appendResults(body, reply);
    }
    const final = await execute(executor, body);
    expect((await final.json()).content[0].text).toBe("Finished");
    expect(f.requests).toHaveLength(1);
    expect(f.results.map((r) => r.content[0].text)).toEqual(["toolu_2", "toolu_1", "toolu_2_1", "toolu_1_1"]);
    await vi.waitFor(() => expect(getActiveSdkToolSessionCount()).toBe(0));
  });

  it("accepts a parallel OpenAI result batch through the real request translator", async () => {
    const f = bridge({ ids: ["toolu_1", "toolu_2"] });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const first = await (await execute(executor, initial())).json();
    const openai = {
      tools: [{ type: "function", function: { name: "calculate", parameters: defs[0].input_schema } }],
      messages: [
        { role: "user", content: "Calculate" },
        { role: "assistant", content: null, tool_calls: first.content.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } })) },
        ...first.content.map((b) => ({ role: "tool", tool_call_id: b.id, content: b.id }))
      ]
    };
    const translated = translateRequest("openai", "claude", "claude-test", openai, false, {}, "claude");
    expect(JSON.stringify(translated.system)).not.toContain("You are Claude Code");
    const response = await execute(executor, translated);
    expect(response.status).toBe(200);
    expect((await response.json()).content[0].text).toBe("Finished");
    expect(f.requests).toHaveLength(1);
  });

  it("preserves fallback tool arguments through OpenAI and Responses SSE translation", () => {
    const message = assistant([{ type: "tool_use", id: "toolu_1", name: "calculate", input: { expression: "6*7" } }], "tool_use");
    for (const format of ["openai", "openai-responses"]) {
      const state = initState(format);
      const output = eventsFromCompletedAssistant(message, "claude-test").flatMap((e) => structuredClone(translateResponse("claude", format, e, state)));
      if (format === "openai") {
        const args = output.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []).map((c) => c.function.arguments).join("");
        expect(JSON.parse(args)).toEqual({ expression: "6*7" });
      } else expect(JSON.stringify(output)).toContain('6*7');
    }
  });

  it.each([false, true])("surfaces a failed final SDK result (stream=%s)", async (stream) => {
    const f = bridge({ rounds: 0, failure: true });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const response = await execute(executor, initial(), stream);
    const text = await response.text();
    if (stream) {
      expect(text).toContain('"type":"error"');
      expect(text).not.toContain("event: message_stop");
      expect(text).not.toContain('"stop_reason":"end_turn"');
    } else expect(response.status).toBe(502);
    expect(text).toContain("Hit max turns");
  });

  it("aborts and frees the session when a client cancels an active SSE stream", async () => {
    const f = bridge({ rounds: 0 });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const response = await execute(executor, initial(), true);
    const reader = response.body.getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
    expect(f.requests[0].options.abortController.signal.aborted).toBe(true);
    expect(getActiveSdkToolSessionCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 20)); // late SDK events must not reject the detached consumer
  });

  it.each([false, true])("rejects unsupported controls before dispatch (tools=%s)", async (withTools) => {
    const f = bridge({ rounds: 0 });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const body = { ...initial(), temperature: 0.2 };
    if (!withTools) delete body.tools;
    expect((await execute(executor, body)).status).toBe(422);
    expect(f.requests).toHaveLength(0);
  });

  it.each([false, true])("forwards native thinking and effort consistently (tools=%s)", async (withTools) => {
    const f = bridge({ rounds: 0 });
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const body = { ...initial(), thinking: { type: "disabled" }, output_config: { effort: "low" } };
    if (!withTools) delete body.tools;
    expect((await execute(executor, body)).status).toBe(200);
    expect(f.requests[0].options).toMatchObject({ thinking: { type: "disabled" }, effort: "low" });
  });

  it("expires pending results without replaying the client tool", async () => {
    vi.useFakeTimers();
    const f = bridge();
    const executor = new ClaudeSdkExecutor(f.queryFactory, f.mcpFactory);
    const body = initial();
    const reply = await (await execute(executor, body)).json();
    appendResults(body, reply);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await execute(executor, body)).status).toBe(409);
    expect(f.requests).toHaveLength(1);
  });
});
