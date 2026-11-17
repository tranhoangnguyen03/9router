// Hermetic HTTP acceptance: production build + real SDK/MCP + offline CLI fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "9router-sdk-http-"));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const password = "offline-" + port;
const env = { ...process.env, HOME: temporary, DATA_DIR: join(temporary, "data"), HOSTNAME: "127.0.0.1", PORT: String(port), INITIAL_PASSWORD: password, DISABLE_BACKGROUND_TOKEN_REFRESH: "1", NEXT_TELEMETRY_DISABLED: "1", CLAUDE_CODE_EXECUTABLE: join(root, "tests/fixtures/claude-sdk-cli.cjs") };
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) delete env[key];
const child = spawn(process.execPath, ["custom-server.js"], { cwd: resolve(root, ".next/standalone"), env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
let key;
async function post(path, body, headers = {}) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
function events(text) {
  return text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
}
try {
  let healthy = false;
  for (let i = 0; i < 120; i++) {
    try { healthy = (await fetch(base + "/api/health")).ok; } catch {}
    if (healthy) break;
    if (child.exitCode != null) throw new Error("Standalone server exited: " + logs);
    await new Promise((done) => setTimeout(done, 250));
  }
  assert(healthy, "Standalone startup timed out: " + logs);
  const login = await post("/api/auth/login", { password });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  key = (await (await post("/api/keys", { name: "Offline SDK acceptance" }, { cookie })).json()).key;
  assert(key);
  for (const native of [true, false]) for (const stream of [false, true]) {
    const path = native ? "/v1/messages" : "/v1/chat/completions";
    const tool = { name: "calculate", input_schema: { type: "object", properties: { expression: { type: "string" } } } };
    const body = { model: "cc/claude-test", stream, max_tokens: 32, ...(native ? { system: "Offline test" } : {}), tools: native ? [tool] : [{ type: "function", function: { name: tool.name, parameters: tool.input_schema } }], messages: [{ role: "user", content: "parallel" }] };
    const response = await post(path, body);
    let calls;
    if (stream) {
      const parsed = events(await response.text());
      const byIndex = new Map();
      for (const event of parsed) {
        if (native) {
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") byIndex.set(event.index, { ...event.content_block, partial: "" });
          if (event.delta?.type === "input_json_delta") byIndex.get(event.index).partial += event.delta.partial_json;
        } else for (const call of event.choices?.[0]?.delta?.tool_calls || []) {
          if (call.function?.name) byIndex.set(call.index, { id: call.id, type: "function", function: { name: call.function.name, arguments: "" } });
          byIndex.get(call.index).function.arguments += call.function?.arguments || "";
        }
      }
      calls = [...byIndex.values()].map((call) => {
        if (!native) return call;
        const { partial, ...block } = call;
        return { ...block, input: JSON.parse(partial) };
      });
    } else {
      const json = await response.json();
      calls = native ? json.content : json.choices[0].message.tool_calls;
    }
    assert.equal(calls.length, 2);
    assert(calls.every((c) => (native ? c.name : c.function.name) === "calculate"));
    calls.forEach((call, i) => assert.deepEqual(native ? call.input : JSON.parse(call.function.arguments), { expression: String(i) }));
    if (native) body.messages.push({ role: "assistant", content: calls }, { role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: c.id })) });
    else body.messages.push({ role: "assistant", content: null, tool_calls: calls }, ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: c.id })));
    body.stream = false;
    const result = await (await post(path, body)).json();
    const text = native ? result.content[0].text : result.choices[0].message.content;
    assert(text.includes("toolu_0") && text.includes("toolu_1"), JSON.stringify(result));
    console.log(`PASS ${path}: ${stream ? "SSE" : "JSON"} parallel tools → JSON continuation`);
  }
} catch (error) {
  console.error(logs.slice(-12000));
  throw error;
} finally {
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, new Promise((done) => setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000).unref())]);
  await rm(temporary, { recursive: true, force: true });
}
