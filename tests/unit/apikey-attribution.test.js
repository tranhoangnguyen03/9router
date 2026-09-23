import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fresh DATA_DIR BEFORE importing the db layer
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-usage-attribution-"));
process.env.DATA_DIR = tmp;

let usageRepo, apiKeysRepo;
let keyA, keyB;

const T = (prompt, cached, completion) => ({
  prompt_tokens: prompt, cached_tokens: cached, completion_tokens: completion,
  cache_creation_input_tokens: 0, total_tokens: prompt + completion,
});

beforeAll(async () => {
  usageRepo = await import("../../src/lib/db/repos/usageRepo.js");
  apiKeysRepo = await import("../../src/lib/db/repos/apiKeysRepo.js");

  // Same machineId → both keys share the sk-{machineId}- prefix → identical maskApiKey()
  keyA = (await apiKeysRepo.createApiKey("KeyA", "aaaaaaaaaaaaaaaa")).key;
  keyB = (await apiKeysRepo.createApiKey("KeyB", "aaaaaaaaaaaaaaaa")).key;

  const now = new Date().toISOString();
  const rows = [
    { apiKey: keyA, model: "gpt-5.2", tokens: T(10000, 4000, 2000) },
    { apiKey: keyB, model: "gpt-5.2", tokens: T(3000, 0, 500) },
    { apiKey: null, model: "gpt-5.2", tokens: T(5000, 0, 500) },
    { apiKey: null, model: "gpt-4o", tokens: T(200, 0, 50) },
  ];
  for (const r of rows) {
    await usageRepo.saveRequestUsage({
      provider: "openai", model: r.model, tokens: r.tokens, timestamp: now,
      connectionId: "conn-1", apiKey: r.apiKey || undefined, endpoint: "/v1/chat/completions",
    });
  }
});

function apiKeyRows(stats) {
  return Object.entries(stats.byApiKey).map(([k, v]) => ({
    key: k, keyName: v.keyName, rawModel: v.rawModel,
    requests: v.requests, promptTokens: v.promptTokens, completionTokens: v.completionTokens,
    cost: v.cost,
  }));
}

describe("api key x model attribution across periods", () => {
  it("keeps distinct API keys separate in 24h/today view (masked-prefix collision)", async () => {
    const today = await usageRepo.getUsageStats("today");
    const gpt52 = apiKeyRows(today).filter((r) => r.rawModel === "gpt-5.2" && r.keyName !== "Local (No API Key)");
    expect(gpt52).toHaveLength(2); // one row per key, not one merged row
    const byName = Object.fromEntries(gpt52.map((r) => [r.keyName, r]));
    expect(byName.KeyA.promptTokens).toBe(10000);
    expect(byName.KeyB.promptTokens).toBe(3000);
  });

  it("keeps distinct API keys separate in daily-summary view", async () => {
    const d7 = await usageRepo.getUsageStats("7d");
    const gpt52 = apiKeyRows(d7).filter((r) => r.rawModel === "gpt-5.2" && r.keyName !== "Local (No API Key)");
    expect(gpt52).toHaveLength(2);
    const byName = Object.fromEntries(gpt52.map((r) => [r.keyName, r]));
    expect(byName.KeyA.promptTokens).toBe(10000);
    expect(byName.KeyB.promptTokens).toBe(3000);
  });

  it("keeps per-model rows for local (no-key) usage in 24h/today view", async () => {
    const today = await usageRepo.getUsageStats("today");
    const local = apiKeyRows(today).filter((r) => r.keyName === "Local (No API Key)");
    expect(local).toHaveLength(2); // gpt-5.2 AND gpt-4o rows, not one merged
    const models = local.map((r) => r.rawModel).sort();
    expect(models).toEqual(["gpt-4o", "gpt-5.2"]);
    expect(local.find((r) => r.rawModel === "gpt-5.2").promptTokens).toBe(5000);
    expect(local.find((r) => r.rawModel === "gpt-4o").promptTokens).toBe(200);
  });

  it("agrees between today and 7d on per-key cost totals", async () => {
    const today = await usageRepo.getUsageStats("today");
    const d7 = await usageRepo.getUsageStats("7d");
    const sum = (s) => apiKeyRows(s).filter((r) => r.keyName === "KeyA").reduce((a, r) => a + r.cost, 0);
    expect(sum(today)).toBeCloseTo(sum(d7), 9);
    expect(sum(d7)).toBeGreaterThan(0);
  });
});
