import { describe, expect, it } from "vitest";
import { sortUsageGroups, totalTokens } from "../../src/app/portal/sortUsage.js";

describe("viewer usage sorting", () => {
  const groups = [
    { id: "first", inputTokens: 30, outputTokens: 10, cachedTokens: 20, estimatedCost: 1, keys: [
      { id: "a", inputTokens: 30, outputTokens: 10, cachedTokens: 20, estimatedCost: 1 },
      { id: "b", inputTokens: 20, outputTokens: 20, cachedTokens: 0, estimatedCost: 2 },
    ] },
    { id: "second", inputTokens: 10, outputTokens: 60, estimatedCost: 0.5, keys: [
      { id: "c", inputTokens: 10, outputTokens: 60, estimatedCost: 0.5 },
    ] },
  ];

  it("preserves published order, counts cached tokens only once, and breaks ties by published order", () => {
    expect(sortUsageGroups(groups, "published")).toBe(groups);
    expect(totalTokens(groups[0].keys[0])).toBe(40);
    const sorted = sortUsageGroups(groups, "tokens");
    expect(sorted.map((group) => group.id)).toEqual(["second", "first"]);
    expect(sorted[1].keys.map((key) => key.id)).toEqual(["a", "b"]);
    expect(groups[0].keys.map((key) => key.id)).toEqual(["a", "b"]);
  });

  it("orders both groups and their keys by estimated cost", () => {
    const sorted = sortUsageGroups(groups, "cost");
    expect(sorted.map((group) => group.id)).toEqual(["first", "second"]);
    expect(sorted[0].keys.map((key) => key.id)).toEqual(["b", "a"]);
  });
});
