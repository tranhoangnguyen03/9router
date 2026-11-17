#!/usr/bin/env node
// Offline CLI protocol fixture. Uses the real Agent SDK and MCP transport, not Anthropic.
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = randomUUID();
let expected = 0;
const results = new Map();
function assistant(content, stop_reason) {
  const message = { id: "msg_" + randomUUID(), type: "message", role: "assistant", model: "claude-test", content, stop_reason, usage: { input_tokens: 3, output_tokens: 1 } };
  const event = (event) => send({ type: "stream_event", event, parent_tool_use_id: null, session_id, uuid: randomUUID() });
  event({ type: "message_start", message: { ...message, content: [] } });
  content.forEach((block, index) => {
    event({ type: "content_block_start", index, content_block: block });
    event({ type: "content_block_stop", index });
  });
  event({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 1 } });
  event({ type: "message_stop" });
  send({ type: "assistant", message, parent_tool_use_id: null, session_id, uuid: randomUUID() });
}
function finish() {
  assistant([{ type: "text", text: [...results.values()].join(",") || "Offline OK" }], "end_turn");
  send({ type: "result", subtype: "success", is_error: false, result: "Offline OK", session_id, uuid: randomUUID(), duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: {}, permission_denials: [] });
  setTimeout(() => process.exit(0), 10);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [], account: {} } } });
  } else if (m.type === "user") {
    send({ type: "system", subtype: "init", session_id, uuid: randomUUID(), tools: [], mcp_servers: [{ name: "router", status: "connected" }], model: "claude-test", permissionMode: "dontAsk", apiKeySource: "none", claude_code_version: "offline-fixture" });
    expected = m.message.content[0].text.includes("parallel") ? 2 : 0;
    if (!expected) return finish();
    const calls = Array.from({ length: expected }, (_, i) => ({ type: "tool_use", id: "toolu_" + i, name: "mcp__router__t0", input: { expression: String(i) } }));
    assistant(calls, "tool_use");
    for (const call of calls.toReversed()) send({ type: "control_request", request_id: call.id, request: { subtype: "mcp_message", server_name: "router", message: { jsonrpc: "2.0", id: call.id, method: "tools/call", params: { name: "t0", arguments: call.input, _meta: { "claudecode/toolUseId": call.id } } } } });
  } else if (m.type === "control_response" && m.response?.request_id?.startsWith("toolu_")) {
    const response = m.response.response?.mcp_response;
    if (response?.error) throw new Error(JSON.stringify(response.error));
    results.set(m.response.request_id, response.result.content[0].text);
    if (results.size === expected) finish();
  }
});
