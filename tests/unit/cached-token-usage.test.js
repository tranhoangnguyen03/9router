import { describe, it, expect } from "vitest";
import { canonicalizeUsage, extractUsage, mergeUsage } from "../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens, calculateCostBreakdown } from "../../open-sse/providers/pricing.js";
import { buildUsage, toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";

// Canonical convention (single source of truth for storage + cost):
//   prompt_tokens             = total input INCLUDING cache read + cache creation
//   cached_tokens             = cache-read portion (subset of prompt_tokens)
//   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
//   completion_tokens         = output
// Discriminator: Claude reports cache separately (prompt EXCLUDES cache);
// OpenAI/Gemini report prompt INCLUDING cached_tokens.
describe("canonicalizeUsage", () => {
  it("folds Claude exclusive cache into an inclusive prompt count", () => {
    // Claude: input_tokens excludes cache; cache_read + cache_creation are separate
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    expect(out.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(out.completion_tokens).toBe(50);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(30);
  });

  it("passes through OpenAI inclusive prompt unchanged", () => {
    // OpenAI: prompt_tokens already includes cached_tokens (a subset)
    const out = canonicalizeUsage({
      prompt_tokens: 330,
      completion_tokens: 50,
      cached_tokens: 200,
    });
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("passes through Gemini inclusive prompt (cachedContent already counted)", () => {
    const out = canonicalizeUsage({
      prompt_tokens: 500,
      completion_tokens: 80,
      cached_tokens: 120,
      reasoning_tokens: 40,
    });
    expect(out.prompt_tokens).toBe(500);
    expect(out.cached_tokens).toBe(120);
    expect(out.reasoning_tokens).toBe(40);
  });

  it("reads cached_tokens from the nested buildUsage() shape", () => {
    // buildUsage() only emits cache reads under prompt_tokens_details. The
    // Responses translator overwrites state.usage with that shape on
    // response.completed, so a top-level-only read silently drops the cache
    // count for every Responses provider (codex, grok-cli, ...).
    const out = canonicalizeUsage(
      buildUsage({ promptTokens: 330, completionTokens: 50, totalTokens: 380, cachedTokens: 200 })
    );
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
  });

  it("handles no-cache usage", () => {
    const out = canonicalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(out.prompt_tokens).toBe(100);
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("is idempotent (running twice yields the same canonical shape)", () => {
    const once = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    const twice = canonicalizeUsage(once);
    expect(twice.prompt_tokens).toBe(330);
    expect(twice.cached_tokens).toBe(200);
    expect(twice.cache_creation_input_tokens).toBe(30);
    expect(twice.completion_tokens).toBe(50);
  });

  it("returns null for invalid input", () => {
    expect(canonicalizeUsage(null)).toBeNull();
    expect(canonicalizeUsage(undefined)).toBeNull();
  });

  it("folds a Claude cache-miss first write (cache_creation only, no cache_read yet)", () => {
    // Cache-miss on first write: upstream emits cache_creation_input_tokens but
    // no cache_read_input_tokens at all (not even 0). Must still fold into prompt
    // instead of falling through to the OpenAI passthrough branch.
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      cache_creation_input_tokens: 500,
    });
    expect(out.prompt_tokens).toBe(600); // 100 + 0 (no read) + 500
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(500);
  });

  it("normalizes Responses API nested cache/reasoning fields", () => {
    const out = canonicalizeUsage({
      input_tokens: 1000,          // cache-inclusive
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens_details: { reasoning_tokens: 40 },
    });
    expect(out.prompt_tokens).toBe(1000);
    expect(out.cached_tokens).toBe(600);
    expect(out.completion_tokens).toBe(200);
    expect(out.reasoning_tokens).toBe(40);
  });
});

describe("calculateCostFromTokens (canonical inclusive convention)", () => {
  const pricing = { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 };

  it("prices cached + cache_creation as subsets of an inclusive prompt without double-counting", () => {
    // prompt=330 includes 200 cached + 30 cache_creation → 100 full-price input
    const cost = calculateCostFromTokens(
      { prompt_tokens: 330, completion_tokens: 50, cached_tokens: 200, cache_creation_input_tokens: 30 },
      pricing
    );
    const expected =
      (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("does not let cache_creation drive nonCached negative", () => {
    // pathological: cached + creation exceeds prompt → nonCached clamps at 0
    const cost = calculateCostFromTokens(
      { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 80, cache_creation_input_tokens: 40 },
      pricing
    );
    const expected = (0 * 3 + 80 * 0.3 + 40 * 3.75) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("matches plain input pricing when no cache present", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 100, completion_tokens: 50 }, pricing);
    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });
});

describe("calculateCostBreakdown (reasoning is a subset of output)", () => {
  const pricing = { input: 3, output: 15, cached: 0.3, reasoning: 60, cache_creation: 3.75 };

  it("does not double-charge reasoning tokens already counted in output", () => {
    // output=100 includes 90 reasoning + 10 visible text
    const b = calculateCostBreakdown(
      { prompt_tokens: 50, completion_tokens: 100, reasoning_tokens: 90 },
      pricing
    );
    const expected = (50 * 3 + 10 * 15 + 90 * 60) / 1_000_000;
    expect(b.total).toBeCloseTo(expected, 12);
    expect(b.outputCost).toBeCloseTo((10 * 15 + 90 * 60) / 1_000_000, 12);
    expect(b.inputCost + b.cachedCost + b.outputCost).toBeCloseTo(b.total, 12);
  });

  it("total matches calculateCostFromTokens", () => {
    const tokens = { prompt_tokens: 50, completion_tokens: 100, reasoning_tokens: 90 };
    expect(calculateCostBreakdown(tokens, pricing).total).toBeCloseTo(calculateCostFromTokens(tokens, pricing), 12);
  });
});

describe("Anthropic streaming usage (message_start carries cache, message_delta output-only)", () => {
  it("extractUsage reads input + cache from message_start", () => {
    const u = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    expect(u.prompt_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(200);
    expect(u.cache_creation_input_tokens).toBe(30);
  });

  it("merges message_start cache with message_delta output without clobbering", () => {
    // Real Anthropic SSE: cache only in message_start, real output only in message_delta.
    const start = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 50 } });
    const merged = mergeUsage(start, delta);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.cache_creation_input_tokens).toBe(30);
    expect(merged.completion_tokens).toBe(50);

    // And it canonicalizes to a cache-inclusive prompt for storage/cost.
    const canon = canonicalizeUsage(merged);
    expect(canon.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(canon.cached_tokens).toBe(200);
    expect(canon.cache_creation_input_tokens).toBe(30);
    expect(canon.completion_tokens).toBe(50);
  });

  it("does not let a NaN field poison the running max-merge", () => {
    // typeof NaN === "number", so a naive Math.max(prev, NaN) is NaN — one
    // malformed chunk must not wipe out an already-accumulated good value.
    const prev = { prompt_tokens: 100, cache_read_input_tokens: 200 };
    const bad = { prompt_tokens: NaN, completion_tokens: 50 };
    const merged = mergeUsage(prev, bad);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.completion_tokens).toBe(50);
  });
});

describe("Gemini/Antigravity streaming usage (thinking folds into completion)", () => {
  it("extractUsage folds the separate thoughts bucket into completion_tokens", () => {
    const u = extractUsage({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 40,
        totalTokenCount: 170,
        cachedContentTokenCount: 10,
      },
    });
    expect(u.completion_tokens).toBe(70); // 30 candidates + 40 thoughts
    expect(u.reasoning_tokens).toBe(40);
    expect(u.prompt_tokens).toBe(100);
  });

  it("keeps reasoning a subset of completion through pricing (no under/over charge)", () => {
    const canon = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 70,
      cached_tokens: 10,
      reasoning_tokens: 40,
    });
    const pricing = { input: 3, output: 15, cached: 0.3, reasoning: 60, cache_creation: 3.75 };
    const b = calculateCostBreakdown(canon, pricing);
    const expected =
      (90 * 3 + 10 * 0.3 + 30 * 15 + 40 * 60) / 1_000_000;
    expect(b.total).toBeCloseTo(expected, 12);
    expect(b.outputCost).toBeCloseTo((30 * 15 + 40 * 60) / 1_000_000, 12);
  });
});

describe("Kiro usage pass-through", () => {
  it("passes through plain input/output when no cache fields are present", () => {
    const out = toOpenAIUsage({ inputTokens: 100, outputTokens: 50 }, "kiro");
    expect(out.prompt_tokens).toBe(100);
    expect(out.completion_tokens).toBe(50);
    expect(out.total_tokens).toBe(150);
    expect(out.prompt_tokens_details).toBeUndefined();
  });

  it("forward-compat: surfaces cache fields if Kiro event shape grows them", () => {
    // ponytail: Amazon Q upstream doesn't expose cache today, but if it starts
    // sending cache_read_input_tokens / cache_creation_input_tokens / cachedTokens,
    // cost tracking should pick them up automatically without another change.
    const out = toOpenAIUsage(
      { inputTokens: 500, outputTokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      "kiro"
    );
    expect(out.prompt_tokens_details).toBeDefined();
    expect(out.prompt_tokens_details.cached_tokens).toBe(200);
    expect(out.prompt_tokens_details.cache_creation_tokens).toBe(50);
  });
});
