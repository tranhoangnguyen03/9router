export function totalTokens(metric) {
  return (metric.inputTokens || 0) + (metric.outputTokens || 0);
}

export function sortUsageGroups(groups, sortBy) {
  if (sortBy === "published") return groups;
  const value = sortBy === "tokens" ? totalTokens : (metric) => metric.estimatedCost || 0;
  const compare = (a, b) => value(b) - value(a);
  return groups.map((group) => ({ ...group, keys: [...group.keys].sort(compare) })).sort(compare);
}
