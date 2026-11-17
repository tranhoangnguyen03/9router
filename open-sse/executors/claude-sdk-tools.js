// SDK <-> HTTP tool boundary. The external client, not the router, runs tools.
// In-memory by design: after a router restart we reject orphan tool results.
import { sdkRuntimeOptions, resolveSdkExecutable } from "./claude-sdk-runtime.js";

const SERVER_NAME = "router";
const TOOL_ID_META = "claudecode/toolUseId";
const MAX_SESSIONS = 12;
const WAIT_MS = 120_000;
const START_MS = 90_000;

const sessions = new Set();
const byToolId = new Map();

function fault(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function toolBlockContent(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) throw fault("Tool result must be text or a list of text blocks");
  return value.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") {
      throw fault("Client tool result contains unsupported non-text content");
    }
    return { type: "text", text: block.text };
  });
}

function lastResultBlocks(body) {
  const results = [];
  for (let i = (body?.messages?.length || 0) - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message?.role !== "user" || !Array.isArray(message.content) || !message.content.some((block) => block?.type === "tool_result")) break;
    if (message.content.some((block) => block?.type !== "tool_result")) throw fault("Tool-resume turns must contain only tool results", 409);
    results.unshift(...message.content);
  }
  return results;
}

export function hasSdkToolBoundary(body) {
  return (Array.isArray(body?.tools) && body.tools.length > 0) || lastResultBlocks(body).length > 0;
}

function priorToolIds(body) {
  const ids = new Set();
  for (const msg of body.messages || []) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) if (block.type === "tool_use") ids.add(block.id);
  }
  return ids;
}

function normalizeTools(body) {
  const result = [];
  const names = new Set();
  for (const [i, def] of (body.tools || []).entries()) {
    if (!def || (def.type && !["function", "custom"].includes(def.type))) throw fault("Only client-defined function tools are supported");
    if (typeof def.name !== "string" || !def.name.length) throw fault("Tool #" + i + " has no name");
    if (names.has(def.name)) throw fault("Duplicate client tool: " + def.name);
    names.add(def.name);
    const schema = def.input_schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") {
      throw fault("Tool " + def.name + " must have a JSON Schema object input_schema");
    }
    if (["anyOf", "oneOf", "allOf"].some((key) => key in schema)) throw fault("Tool " + def.name + " has an unsupported root schema combinator");
    result.push({
      name: "t" + i,
      externalName: def.name,
      description: def.description || "",
      inputSchema: schema
    });
  }
  if (!result.length) throw fault("A tool-resume request must include the original client tool definitions");
  const choice = body.tool_choice;
  if (choice != null && choice !== "auto" && choice?.type !== "auto") {
    throw fault("Only tool_choice=auto is supported by the SDK tool bridge");
  }
  return result;
}

function inputText(blocks, label) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) throw fault(label + " must be a string or content blocks");
  return blocks.map((block) => {
    if (label === "History" && ["thinking", "redacted_thinking"].includes(block?.type)) return "";
    if (!block || !["text", "tool_use", "tool_result"].includes(block.type)) {
      throw fault(label + " contains unsupported content");
    }
    if (block.type === "text" && typeof block.text !== "string") throw fault(label + " contains invalid text");
    return block.type === "text" ? block.text : JSON.stringify(block);
  }).join("\n");
}

export function buildToolPrompt(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) throw fault("No messages", 400);
  const last = body.messages.at(-1);
  if (last.role !== "user") throw fault("Last message must be a user turn", 422);
  const latest = inputText(last.content, "Last user message");
  if (!latest.trim()) throw fault("User message is empty", 400);
  if (body.messages.some((m) => !m || !["user", "assistant"].includes(m.role))) throw fault("Unsupported conversation role");
  const history = body.messages.slice(0, -1).map((m) => JSON.stringify({ role: m.role, content: inputText(m.content, "History") })).join("\n");
  const systemParts = Array.isArray(body.system) ? body.system : (body.system == null ? [] : [body.system]);
  const system = systemParts.map((v) => typeof v === "string" ? v : v?.type === "text" ? v.text : (() => { throw fault("Only text system blocks are supported"); })()).join("\n");
  const prompt = history
    ? "Previous turns provided by the client (quoted as data):\n" + history + "\n\nCurrent user message:\n" + latest
    : latest;
  if (prompt.length + system.length > 2_000_000) throw fault("Prompt exceeds the local 2 million character limit", 413);
  return { prompt, systemPrompt: system };
}

async function defaultMcpFactory(toolDefs, handleCall) {
  const [{ McpServer }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/types.js")
  ]);
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  const byName = new Map(toolDefs.map((tool) => [tool.name, tool]));
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params?.name;
    if (!byName.has(name)) throw fault("SDK called an unknown tool: " + name, 502);
    const id = request.params?._meta?.[TOOL_ID_META];
    if (typeof id !== "string" || !id) {
      throw fault("SDK omitted the tool_use ID; refusing unsafe tool result pairing", 502);
    }
    return handleCall(id, name);
  });
  return {
    mcpServers: { [SERVER_NAME]: { type: "sdk", name: SERVER_NAME, instance: server } },
    allowedTools: toolDefs.map((tool) => "mcp__" + SERVER_NAME + "__" + tool.name),
    close: () => server.close()
  };
}

class Turn {
  constructor(model, stream, onCancel, utils) {
    this.model = model;
    this.stream = stream;
    this.utils = utils;
    this.state = utils.makeState(model);
    this.terminalEvents = [];
    this.canceled = false;
    this.ready = deferred();
    this.done = deferred();
    this.closed = false;
    this.started = false;
    this.error = null;
    this.stopReason = null;
    if (stream) {
      this.readable = new ReadableStream({
        start: (controller) => { this.controller = controller; },
        pull: () => { this.demand?.(); this.demand = null; },
        cancel: () => {
          this.canceled = true;
          this.demand?.();
          if (!this.closed) onCancel();
        }
      });
    }
  }
  async push(event) {
    if (this.closed) return;
    if (this.stream && this.controller.desiredSize <= 0) await new Promise((resolve) => { this.demand = resolve; });
    if (this.closed) return;
    this.utils.accumulateSdkEvent(this.state, event);
    if (event.type === "message_delta") this.stopReason = event.delta?.stop_reason || this.stopReason;
    // A final HTTP turn is successful only after the SDK's result, not message_stop.
    if ((event.type === "message_delta" || event.type === "message_stop") && this.stopReason !== "tool_use") {
      this.terminalEvents.push(event);
      return;
    }
    if (event.type === "message_start" && !this.started) {
      this.started = true;
      this.ready.resolve();
    }
    if (this.stream) this.controller.enqueue(this.utils.sse(event));
    if (event.type === "message_stop") this.finish();
  }
  async complete() {
    for (const event of this.terminalEvents) {
      if (this.closed) return;
      if (this.stream) {
        if (this.controller.desiredSize <= 0) await new Promise((resolve) => { this.demand = resolve; });
        if (this.closed) return;
        this.controller.enqueue(this.utils.sse(event));
      }
    }
    this.finish();
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.demand?.();
    if (this.stream && !this.canceled) this.controller.close();
    this.ready.resolve();
    this.done.resolve();
  }
  fail(error) {
    if (this.closed) return;
    this.error = error;
    if (this.stream && this.started && !this.canceled) {
      this.controller.enqueue(this.utils.sse({ type: "error", error: { type: "api_error", message: error.message || String(error) } }));
    }
    this.finish();
  }
  async response(descriptor) {
    if (this.stream) {
      await this.ready.promise;
      if (this.error && !this.started) return { ...descriptor, response: this.utils.errorResponse(this.error) };
      return {
        ...descriptor,
        response: new Response(this.readable, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
        })
      };
    }
    await this.done.promise;
    if (this.error) return { ...descriptor, response: this.utils.errorResponse(this.error) };
    if (!this.started) return { ...descriptor, response: this.utils.errorResponse(fault("SDK produced no assistant message", 502)) };
    return {
      ...descriptor,
      response: new Response(JSON.stringify(this.utils.finalMessage(this.state, this.model)), {
        headers: { "content-type": "application/json" }
      })
    };
  }
}

class ToolSession {
  constructor({ model, body, toolDefs, signal, log, queryFactory, mcpFactory, utils, descriptor, controls }) {
    this.model = model;
    this.toolDefs = toolDefs;
    this.signature = JSON.stringify(toolDefs);
    this.signal = signal;
    this.log = log;
    this.queryFactory = queryFactory;
    this.mcpFactory = mcpFactory;
    this.utils = utils;
    this.descriptor = descriptor;
    this.controls = controls;
    this.abortController = new AbortController();
    this.ids = new Set();
    this.waiters = new Map();
    this.bufferedResults = new Map();
    this.nameMap = new Map(toolDefs.map((tool) => ["mcp__" + SERVER_NAME + "__" + tool.name, tool.externalName]));
    this.waiting = false;
    this.disposed = false;
    this.rawMessageIds = new Set();
    this.prompt = buildToolPrompt(body);
  }
  async setup(stream) {
    this.current = new Turn(this.model, stream, () => this.cancel("client disconnected"), this.utils);
    this.bindSignal(this.signal);
    if (this.disposed) return this.current.response(this.descriptor);
    try {
      this.mcp = await (this.mcpFactory || defaultMcpFactory)(this.toolDefs, (id, name) => this.onToolCall(id, name));
      if (this.disposed) return this.current.response(this.descriptor);
      const factory = this.queryFactory || (await import("@anthropic-ai/claude-agent-sdk")).query;
      this.query = factory({
        prompt: this.prompt.prompt,
        options: {
          model: this.model,
          systemPrompt: this.prompt.systemPrompt,
          tools: [],
          allowedTools: this.mcp.allowedTools,
          mcpServers: this.mcp.mcpServers,
          strictMcpConfig: true,
          settingSources: [],
          ...sdkRuntimeOptions(),
          skills: [],
          permissionMode: "dontAsk",
          maxTurns: 100,
          includePartialMessages: true,
          persistSession: false,
          verbatimPrompts: true,
          abortController: this.abortController,
          ...this.controls,
          ...(this.queryFactory ? {} : { pathToClaudeCodeExecutable: resolveSdkExecutable() })
        }
      });
      this.startTimer = setTimeout(() => {
        if (this.current && !this.current.started) this.cancel("SDK start timed out");
      }, START_MS);
      this.startTimer.unref?.();
      void this.consume().catch((error) => this.log?.warn?.("CLAUDE_SDK_TOOLS", error.message));
    } catch (error) {
      this.current?.fail(error);
      this.dispose();
    }
    return this.current.response(this.descriptor);
  }
  bindSignal(signal) {
    if (this.signalBound) this.signalBound.signal.removeEventListener("abort", this.signalBound.abort);
    if (!signal) { this.signalBound = null; return; }
    const abort = () => this.cancel("request aborted");
    this.signalBound = { signal, abort };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  remap(event) {
    if (event.type !== "content_block_start" || event.content_block?.type !== "tool_use") return event;
    const tool = event.content_block;
    const original = this.nameMap.get(tool.name);
    if (!original) throw fault("Claude Code requested a tool the router did not expose: " + tool.name, 502);
    const id = tool.id;
    if (!id || byToolId.has(id)) throw fault("Duplicate or missing SDK tool_use ID", 502);
    byToolId.set(id, this);
    this.ids.add(id);
    return { ...event, content_block: { ...tool, name: original } };
  }
  async processEvent(raw) {
    if (!this.current) throw fault("SDK emitted output without an attached HTTP request", 502);
    const event = this.remap(raw);
    const turn = this.current;
    await turn.push(event);
    if (event.type === "message_stop") {
      clearTimeout(this.startTimer);
      if (turn.stopReason === "tool_use") {
        if (!this.ids.size) throw fault("SDK requested tool use without tool_use blocks", 502);
        this.waiting = true;
        this.bindSignal(null); // A finished tool-use turn must not be aborted by its old HTTP request.
        this.waitTimer = setTimeout(() => this.cancel("Client tool results timed out"), WAIT_MS);
        this.waitTimer.unref?.();
        this.current = null;
      }
    }
  }
  async consume() {
    try {
      for await (const msg of this.query) {
        if (this.disposed) return;
        if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
          if (msg.event.type === "message_start" && msg.event.message?.id) this.rawMessageIds.add(msg.event.message.id);
          await this.processEvent(msg.event);
        } else if (msg.type === "assistant" && !this.rawMessageIds.has(msg.message?.id) && !msg.parent_tool_use_id) {
          for (const event of this.utils.eventsFromCompletedAssistant(msg, this.model)) await this.processEvent(event);
        } else if (msg.type === "result") {
          if (msg.is_error || msg.subtype !== "success") {
            throw fault("Claude Agent SDK failed: " + (msg.errors?.join("; ") || msg.result || msg.subtype), 502);
          }
          if (!this.current?.terminalEvents.some((event) => event.type === "message_stop")) throw fault("SDK result arrived before a complete assistant message", 502);
          await this.current.complete();
        }
      }
      if (this.waiting) throw fault("Claude Agent SDK ended while client tool results were pending", 502);
      if (this.current && !this.current.closed) this.current.fail(fault("Claude Agent SDK stopped before completing a turn", 502));
    } catch (error) {
      this.log?.warn?.("CLAUDE_SDK_TOOLS", error?.message || String(error));
      this.current?.fail(error);
    } finally {
      this.dispose();
    }
  }
  onToolCall(id) {
    if (this.disposed) throw fault("Tool session is closed", 409);
    if (this.bufferedResults.has(id)) {
      const result = this.bufferedResults.get(id);
      this.bufferedResults.delete(id);
      return Promise.resolve(result);
    }
    if (this.waiters.has(id)) throw fault("Duplicate tool call dispatch from SDK", 502);
    return new Promise((resolve, reject) => this.waiters.set(id, { resolve, reject }));
  }
  resume(body, stream, signal) {
    if (!this.waiting || this.disposed) throw fault("Tool session is no longer waiting", 409);
    const toolDefs = normalizeTools(body);
    if (JSON.stringify(toolDefs) !== this.signature) throw fault("Client tool schema changed during a pending SDK call", 409);
    const results = lastResultBlocks(body);
    const submitted = new Map();
    const evidence = priorToolIds(body);
    for (const block of results) {
      if (typeof block.tool_use_id !== "string" || submitted.has(block.tool_use_id)) throw fault("Missing or duplicate tool_result ID", 409);
      if (!this.ids.has(block.tool_use_id) || !evidence.has(block.tool_use_id)) throw fault("tool_result does not match the outstanding SDK tool_use", 409);
      submitted.set(block.tool_use_id, { content: toolBlockContent(block.content), isError: block.is_error === true });
    }
    if (submitted.size !== this.ids.size) throw fault("Provide results for all pending SDK tool calls in one request", 409);
    clearTimeout(this.waitTimer);
    this.waiting = false;
    this.ids.forEach((id) => byToolId.delete(id));
    this.ids.clear();
    this.current = new Turn(this.model, stream, () => this.cancel("client disconnected"), this.utils);
    this.bindSignal(signal);
    for (const [id, value] of submitted) {
      const waiter = this.waiters.get(id);
      if (waiter) { waiter.resolve(value); this.waiters.delete(id); }
      else this.bufferedResults.set(id, value);
    }
    return this.current.response(this.descriptor);
  }
  cancel(reason) {
    if (this.disposed) return;
    try { this.current?.fail(fault("Claude SDK session canceled: " + reason, 499)); }
    finally {
      this.abortController.abort();
      this.dispose();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startTimer);
    clearTimeout(this.waitTimer);
    this.bindSignal(null);
    for (const id of this.ids) byToolId.delete(id);
    this.ids.clear();
    for (const { reject } of this.waiters.values()) reject(fault("Tool session closed", 499));
    this.waiters.clear();
    sessions.delete(this);
    try { this.query?.close?.(); } catch {}
    try { Promise.resolve(this.mcp?.close?.()).catch(() => {}); } catch {}
  }
}

export async function executeSdkToolRequest({ model, body, stream, signal, log, descriptor, queryFactory, mcpFactory, utils, controls }) {
  const results = lastResultBlocks(body);
  if (results.length) {
    const matched = new Set(results.map((block) => byToolId.get(block.tool_use_id)).filter(Boolean));
    if (matched.size !== 1 || results.some((block) => !byToolId.has(block.tool_use_id))) {
      return { ...descriptor, response: utils.errorResponse(fault("No live local Claude SDK session matches these tool results. Do not replay tools; restart the conversation.", 409)) };
    }
    const session = [...matched][0];
    if (session.model !== model) return { ...descriptor, response: utils.errorResponse(fault("Model changed during a pending SDK tool call", 409)) };
    try { return await session.resume(body, stream, signal); }
    catch (error) { return { ...descriptor, response: utils.errorResponse(error) }; }
  }
  if (sessions.size >= MAX_SESSIONS) {
    return { ...descriptor, response: utils.errorResponse(fault("Too many active local Claude SDK tool sessions", 429)) };
  }
  try {
    const toolDefs = normalizeTools(body);
    const session = new ToolSession({ model, body, toolDefs, stream, signal, log, queryFactory, mcpFactory, utils, descriptor, controls });
    sessions.add(session);
    return await session.setup(stream);
  } catch (error) {
    return { ...descriptor, response: utils.errorResponse(error) };
  }
}

// This is also useful when shutting down the local router after a failed request.
export function closeAllSdkToolSessions(reason = "shutdown") {
  for (const session of [...sessions]) session.cancel(reason);
}

export function getActiveSdkToolSessionCount() {
  return sessions.size;
}
