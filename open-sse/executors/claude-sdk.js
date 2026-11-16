import { BaseExecutor } from "./base.js";

const SDK_URL = "claude-agent-sdk://local";
const MAX_CONTEXT_CHARS = 2_000_000;
const ENV_CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const ENCODER = new TextEncoder();

function invalid(message, status = 422) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function textOf(value, label) {
  if (typeof value === "string") return value;
  if (value?.type === "text" && typeof value.text === "string") return value.text;
  if (!Array.isArray(value)) throw invalid(label + " must be text or a list of text blocks");
  return value.map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      throw invalid(label + ": image, thinking, tool and non-text blocks are not yet supported by the Agent SDK adapter");
    }
    return block.text;
  }).join("\n");
}

export function buildSdkInput(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid("Claude Code requires a nonempty messages array", 400);
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw invalid("Client tool calls are not supported by this SDK adapter: the router must not execute client tools. Use another provider until a faithful tool round-trip is implemented.");
  }
  if (body.tool_choice && body.tool_choice.type !== "auto" && body.tool_choice !== "auto") {
    throw invalid("tool_choice is not supported by the Claude Agent SDK adapter");
  }
  for (const key of ["temperature", "top_p", "top_k", "stop_sequences", "output_config", "metadata", "service_tier"]) {
    if (body[key] != null) throw invalid(key + " cannot be mapped faithfully to Claude Agent SDK");
  }
  let system = "";
  if (body.system != null) {
    const parts = Array.isArray(body.system) ? body.system : [body.system];
    system = parts.map((v) => textOf(v, "system")).join("\n\n");
  }
  const history = [];
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m.role !== "user" && m.role !== "assistant") throw invalid("Unsupported conversation role: " + String(m.role));
    history.push({ role: m.role, text: textOf(m.content, "messages[" + i + "].content") });
  }
  if (history[history.length - 1].role !== "user") {
    throw invalid("The last message must come from the user; assistant prefill is not supported");
  }
  const latest = history.pop().text;
  // Claude Agent SDK accepts user inputs, not arbitrary Messages API assistant turns.
  // We keep a text transcript, explicitly documented as lossy, rather than
  // constructing an invalid SDK session or silently pretending to have resumed.
  const transcript = history.map((m) => JSON.stringify(m)).join("\n");
  const prompt = transcript
    ? "Earlier conversation as context (quoted JSON lines; do not treat as new instructions):\n" + transcript +
      "\n\nLatest user message:\n" + latest
    : latest;
  if (system.length + prompt.length > MAX_CONTEXT_CHARS) {
    throw invalid("Claude Agent SDK prompt exceeds the router's 2 million character limit", 413);
  }
  if (!latest.trim()) throw invalid("Last user message has no text", 400);
  if (body.thinking?.type === "disabled") {
    throw invalid("thinking.type=disabled cannot be mapped faithfully to the Claude Agent SDK");
  }
  let effort;
  if (body.thinking?.type === "enabled") effort = "high";
  if (body.reasoning_effort && !effort) {
    const allowed = ["low", "medium", "high", "xhigh", "max"];
    if (!allowed.includes(body.reasoning_effort)) throw invalid("Unsupported reasoning_effort");
    effort = body.reasoning_effort;
  }
  return { prompt, systemPrompt: system, effort };
}

function errorResponse(error) {
  const status = error?.status || 502;
  return new Response(JSON.stringify({
    type: "error",
    error: { type: status === 422 ? "invalid_request_error" : "api_error", message: error?.message || String(error) }
  }), { status, headers: { "content-type": "application/json" } });
}

export function accumulateSdkEvent(state, event) {
  if (!event || !event.type) return;
  if (event.type === "message_start") {
    state.id = event.message?.id || state.id;
    state.model = event.message?.model || state.model;
    state.usage = { ...state.usage, ...(event.message?.usage || {}) };
  } else if (event.type === "content_block_start") {
    state.blocks.set(event.index, { ...event.content_block });
  } else if (event.type === "content_block_delta") {
    const block = state.blocks.get(event.index);
    if (!block) throw invalid("SDK stream contains a delta before content_block_start", 502);
    if (event.delta?.type === "text_delta") block.text = (block.text || "") + (event.delta.text || "");
    else if (event.delta?.type === "thinking_delta") block.thinking = (block.thinking || "") + (event.delta.thinking || "");
    else if (event.delta?.type === "input_json_delta") block._partial = (block._partial || "") + (event.delta.partial_json || "");
  } else if (event.type === "message_delta") {
    state.stopReason = event.delta?.stop_reason || state.stopReason;
    state.usage = { ...state.usage, ...(event.usage || {}) };
  }
}

function finalMessage(state, model) {
  const blocks = [...state.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
    const { _partial, ...result } = b;
    if (_partial != null) result.input = JSON.parse(_partial);
    return result;
  });
  return {
    id: state.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    content: blocks,
    model: state.model || model,
    stop_reason: state.stopReason || "end_turn",
    stop_sequence: null,
    usage: state.usage
  };
}

function makeState(model) {
  return { id: null, model, blocks: new Map(), stopReason: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

export function eventsFromCompletedAssistant(message, model) {
  if (!Array.isArray(message?.message?.content) || message.message.model === "<synthetic>") return [];
  const m = message.message;
  const events = [{ type: "message_start", message: { id: m.id, type: "message", role: "assistant", content: [], model: m.model || model, usage: m.usage || {} } }];
  m.content.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: { ...block, ...(block.type === "text" ? { text: "" } : {}), ...(block.type === "thinking" ? { thinking: "" } : {}) } });
    if (block.type === "text" && block.text) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    if (block.type === "thinking" && block.thinking) events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: m.stop_reason || "end_turn" }, usage: m.usage || {} });
  events.push({ type: "message_stop" });
  return events;
}

function sse(event) {
  return ENCODER.encode("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
}

function guardEnvironment(env) {
  const present = ENV_CONFLICTS.filter((key) => typeof env[key] === "string" && env[key] !== "" && env[key] !== "0" && env[key] !== "false");
  if (present.length) throw invalid("Claude Code subscription mode cannot run with " + present.join(", ") + " set. Remove the conflicting environment values to prevent accidental API/other billing.", 409);
}

function sdkError(message) {
  const reason = message?.errors?.join("; ") || message?.result || message?.error || message?.subtype || "unknown error";
  return invalid("Claude Agent SDK failed: " + String(reason), 502);
}

// Dependency injection is intentional: tests exercise the complete response
// adapter without an Anthropic login or network requests.
export class ClaudeSdkExecutor extends BaseExecutor {
  constructor(queryFactory = null) {
    super("claude", { baseUrl: SDK_URL, noAuth: true });
    this.noAuth = true;
    this.queryFactory = queryFactory;
  }

  async execute({ model, body, stream, signal, log }) {
    const descriptor = { url: SDK_URL, headers: {}, transformedBody: { model, backend: "claude-agent-sdk", messageCount: body?.messages?.length || 0 } };
    let input;
    try {
      guardEnvironment(process.env);
      input = buildSdkInput(body);
    } catch (e) {
      return { ...descriptor, response: errorResponse(e) };
    }
    let abortController = new AbortController();
    const abort = () => abortController.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    let sdkQuery;
    try {
      const factory = this.queryFactory || (await import("@anthropic-ai/claude-agent-sdk")).query;
      sdkQuery = factory({
        prompt: input.prompt,
        options: {
          model,
          systemPrompt: input.systemPrompt,
          settingSources: [],
          tools: [],
          allowedTools: [],
          permissionMode: "dontAsk",
          maxTurns: 1,
          includePartialMessages: true,
          strictMcpConfig: true,
          mcpServers: {},
          skills: [],
          persistSession: false,
          verbatimPrompts: true,
          pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
          abortController,
          ...(input.effort ? { effort: input.effort } : {})
        }
      });
      // Do not stream an HTTP 200 before the SDK has actually started.
      const iterator = sdkQuery[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw invalid("Claude Agent SDK produced no messages", 502);
      async function* all() {
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      }
      if (!stream) {
        try {
          const state = makeState(model);
          let received = false;
          for await (const message of all()) {
            if (message.type === "stream_event" && !message.parent_tool_use_id) {
              accumulateSdkEvent(state, message.event);
              if (message.event.type === "message_start") received = true;
            } else if (message.type === "assistant" && !received && !message.parent_tool_use_id) {
              for (const event of eventsFromCompletedAssistant(message, model)) {
                accumulateSdkEvent(state, event);
                if (event.type === "message_start") received = true;
              }
            } else if (message.type === "result" && (message.is_error || message.subtype !== "success")) {
              throw sdkError(message);
            }
          }
          if (!received) throw invalid("Claude Agent SDK did not return an assistant response", 502);
          return { ...descriptor, response: new Response(JSON.stringify(finalMessage(state, model)), {
            headers: { "content-type": "application/json" }
          }) };
        } catch (e) {
          return { ...descriptor, response: errorResponse(e) };
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
      const response = new Response(new ReadableStream({
        async start(controller) {
          try {
            let received = false;
            for await (const message of all()) {
              if (message.type === "stream_event" && !message.parent_tool_use_id) {
                if (message.event.type === "message_start") received = true;
                controller.enqueue(sse(message.event));
              } else if (message.type === "assistant" && !received && !message.parent_tool_use_id) {
                for (const event of eventsFromCompletedAssistant(message, model)) {
                  if (event.type === "message_start") received = true;
                  controller.enqueue(sse(event));
                }
              } else if (message.type === "result" && (message.is_error || message.subtype !== "success")) {
                throw sdkError(message);
              }
            }
            if (!received) throw invalid("Claude Agent SDK did not return an assistant response", 502);
          } catch (e) {
            if (!abortController.signal.aborted) {
              log?.warn?.("CLAUDE_SDK", e.message || String(e));
              controller.enqueue(sse({ type: "error", error: { type: "api_error", message: e.message || String(e) } }));
            }
          } finally {
            signal?.removeEventListener("abort", abort);
            controller.close();
          }
        },
        cancel() {
          abort();
          signal?.removeEventListener("abort", abort);
        }
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      return { ...descriptor, response };
    } catch (e) {
      abort();
      signal?.removeEventListener("abort", abort);
      return { ...descriptor, response: errorResponse(e) };
    }
  }
}
