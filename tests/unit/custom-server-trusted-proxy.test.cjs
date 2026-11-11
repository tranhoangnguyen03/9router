const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

// Capture the actual wrapper without opening a port or starting background jobs.
const originalCreateServer = http.createServer;
let handler;
http.createServer = (callback) => {
  handler = callback;
  return { once() {}, emit() {} };
};
process.env.NINEROUTER_TRUSTED_PROXY_IP = "172.17.0.1";
require("../../custom-server.js");
http.createServer((req) => {});
http.createServer = originalCreateServer;

function request(socketIp, headers = {}) {
  const req = { socket: { remoteAddress: socketIp }, headers: { ...headers } };
  handler(req, {});
  return req.headers;
}

test("configured Docker proxy separates visitors and stamps peer proof", () => {
  for (const ip of ["198.51.100.10", "198.51.100.11", "2001:db8::10"]) {
    const headers = request("172.17.0.1", { "x-forwarded-for": ip });
    assert.equal(headers["x-9r-real-ip"], ip);
    assert.equal(headers["x-9r-via-proxy"], "1");
    assert.equal(headers["x-9r-peer-token"], process.env.NINEROUTER_PEER_TOKEN);
    assert.equal(headers["x-forwarded-for"], undefined);
  }
});

test("uses last proxy-appended XFF address, not client headers", () => {
  const headers = request("::ffff:172.17.0.1", {
    "x-forwarded-for": "127.0.0.1, 198.51.100.10",
    "x-real-ip": "127.0.0.1",
    "x-9r-real-ip": "127.0.0.1",
    "x-9r-peer-token": "forged",
  });
  assert.equal(headers["x-9r-real-ip"], "198.51.100.10");
  assert.equal(headers["x-9r-peer-token"], process.env.NINEROUTER_PEER_TOKEN);
  assert.equal(headers["x-9r-via-proxy"], "1");
});

test("other private/public peers cannot supply their own client IP", () => {
  for (const peer of ["172.17.0.2", "10.0.0.1", "198.51.100.20"]) {
    const headers = request(peer, { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" });
    assert.equal(headers["x-9r-real-ip"], peer);
    assert.equal(headers["x-forwarded-for"], undefined);
  }
});

test("missing or malformed forwarded IP falls back to socket", () => {
  for (const xff of [undefined, "", "unknown", "198.51.100.10, invalid", "198.51.100.10,"]) {
    const headers = request("172.17.0.1", { "x-forwarded-for": xff, "x-real-ip": "127.0.0.1" });
    assert.equal(headers["x-9r-real-ip"], "172.17.0.1");
  }
});

test("preserves loopback proxy behavior and strips forged proxy marker", () => {
  const forwarded = request("127.0.0.1", { "x-forwarded-for": "198.51.100.10, 10.0.0.1" });
  assert.equal(forwarded["x-9r-real-ip"], "198.51.100.10");
  assert.equal(forwarded["x-9r-via-proxy"], "1");
  assert.equal(request("198.51.100.10", { "x-9r-via-proxy": "1" })["x-9r-via-proxy"], undefined);
});

test("proxy trust is opt-in and rejects non-IP configuration", () => {
  const cwd = require("node:path").resolve(__dirname, "../..");
  const script = `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    let handler;
    http.createServer = fn => { handler = fn; return {once(){}, emit(){}}; };
    require('./custom-server.js');
    http.createServer(req => assert.equal(req.headers['x-9r-real-ip'], '172.17.0.1'));
    handler({socket:{remoteAddress:'172.17.0.1'}, headers:{'x-forwarded-for':'198.51.100.10'}}, {});
  `;
  const env = { ...process.env, NINEROUTER_TRUSTED_PROXY_IP: "" };
  const result = spawnSync(process.execPath, ["-e", script], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const value of ["172.17.0.0/16", "*", "localhost", "172.17.0.1,10.0.0.1"]) {
    const invalid = spawnSync(process.execPath, ["-e", "require('./custom-server.js')"], {
      cwd, env: { ...env, NINEROUTER_TRUSTED_PROXY_IP: value }, encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /must be one exact IP address/);
  }
});
