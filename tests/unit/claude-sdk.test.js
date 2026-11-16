import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSdkInput, ClaudeSdkExecutor, eventsFromCompletedAssistant } from "../../open-sse/executors/claude-sdk.js";

const BLOCKED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(BLOCKED_ENV.map((key) => [key, process.env[key]]));
  for (const key of BLOCKED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const req = (override = {}) => ({
  model: "claude-sonnet-4-6",
  body: { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], system: [{ type: "text", text: "Answer in one line" }] },
  stream: false,
  ...override
});

function successfulQuery(captured) {
  return (args) => {
    captured.push(args);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "local-session" };
      const rawEvents = [
        { type: "message_start", message: { id: "msg_1", model: args.options.model, role: "assistant", usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello back" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" }
      ];
      for (const event of rawEvents) {
        yield { type: "stream_event", parent_tool_use_id: null, event };
      }
      yield { type: "result", subtype: "success", is_error: false };
    })();
  };
}

describe("Claude Agent SDK adapter", () => {
  it("preserves text system blocks and last user input", () => {
    const input = buildSdkInput(req().body);
    expect(input.prompt).toBe("Hello");
    expect(input.systemPrompt).toBe("Answer in one line");
  });

  it("keeps multi-turn history explicit instead of pretending it is an SDK resumed session", () => {
    const input = buildSdkInput({
      system: "Answer precisely",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Follow-up" }
      ]
    });
    expect(input.prompt).toContain('{"role":"assistant","text":"First reply"}');
    expect(input.prompt).toContain("Latest user message:\nFollow-up");
  });

  it("rejects tools rather than letting Claude Code execute client-side actions", async () => {
    const invoked = vi.fn(() => { throw new Error("must not be invoked"); });
    const executor = new ClaudeSdkExecutor(invoked);
    const result = await executor.execute(req({ body: {
      messages: [{ role: "user", content: "Use the tool" }],
      tools: [{ name: "delete_files", input_schema: { type: "object" } }]
    } }));
    expect(result.response.status).toBe(422);
    expect((await result.response.json()).error.message).toContain("tool");
    expect(invoked).not.toHaveBeenCalled();
  });

  it("does not convert thinking disabled into low thinking", () => {
    expect(() => buildSdkInput({
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "disabled" }
    })).toThrow(/cannot be mapped/);
  });

  it("rejects images and unknown request controls before starting Claude Code", () => {
    expect(() => buildSdkInput({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } }] }]
    })).toThrow(/non-text/);
    expect(() => buildSdkInput({
      messages: [{ role: "user", content: "Hi" }], temperature: 0.8
    })).toThrow(/temperature/);
  });

  it("uses official CLI through SDK with an isolated no-tools configuration", async () => {
    const captured = [];
    const result = await new ClaudeSdkExecutor(successfulQuery(captured)).execute(req());
    expect(result.response.ok).toBe(true);
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: "Hello back" }]);
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
    expect(captured).toHaveLength(1);
    expect(captured[0].options.tools).toEqual([]);
    expect(captured[0].options.mcpServers).toEqual({});
    expect(captured[0].options.maxTurns).toBe(1);
    expect(captured[0].options.pathToClaudeCodeExecutable).toBe(process.env.CLAUDE_CODE_EXECUTABLE || "claude");
  });

  it("preserves event order on SSE streams", async () => {
    const response = (await new ClaudeSdkExecutor(successfulQuery([])).execute(req({ stream: true }))).response;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('text_delta');
    expect(text).toContain("event: message_stop");
    expect(text.indexOf("event: message_start")).toBeLessThan(text.indexOf("event: message_stop"));
  });

  it("uses assistant fallback when Claude Code did not emit partial stream events", async () => {
    const query = () => (async function* () {
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "msg_2", model: "claude-sonnet-4-6", content: [{ type: "text", text: "From fallback" }],
        usage: { input_tokens: 2, output_tokens: 4 }, stop_reason: "end_turn"
      } };
      yield { type: "result", subtype: "success", is_error: false };
    })();
    const response = (await new ClaudeSdkExecutor(query).execute(req())).response;
    expect(response.ok).toBe(true);
    expect((await response.json()).content[0].text).toBe("From fallback");
    expect(eventsFromCompletedAssistant({ message: { model: "<synthetic>", content: [{ type: "text", text: "error" }] } }, "model")).toEqual([]);
  });

  it("never falls back to API-key billing when an Anthropic environment variable is present", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    const invoked = vi.fn();
    const response = (await new ClaudeSdkExecutor(invoked).execute(req())).response;
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("ANTHROPIC_API_KEY");
    expect(invoked).not.toHaveBeenCalled();
  });

  it("surfaces failed SDK result as a failed HTTP response", async () => {
    const query = () => (async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["Account not authorized"] };
    })();
    const response = (await new ClaudeSdkExecutor(query).execute(req())).response;
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain("Account not authorized");
  });
});
