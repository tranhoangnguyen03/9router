import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver";
import { parseJson } from "@/lib/db/helpers/jsonCol";
import { getApiKeys, getProviderNodes } from "@/lib/localDb";
import { getViewerPortalConfig } from "./config.js";
import { getCachedPortalUsage } from "./cache.js";

export const PORTAL_PERIODS = new Set(["24h", "7d", "30d", "60d"]);
const PERIOD_DAYS = { "7d": 7, "30d": 30, "60d": 60 };

const emptyMetric = () => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  estimatedCost: 0,
  lastUsed: null,
  models: new Set(),
  providers: new Set(),
});

function addMetric(target, values) {
  target.requests += values.requests || 0;
  target.inputTokens += values.inputTokens || 0;
  target.outputTokens += values.outputTokens || 0;
  target.cachedTokens += values.cachedTokens || 0;
  target.estimatedCost += values.estimatedCost || 0;
  if (values.model) target.models.add(values.model);
  if (values.provider) target.providers.add(values.provider);
  if (values.lastUsed && (!target.lastUsed || values.lastUsed > target.lastUsed)) target.lastUsed = values.lastUsed;
}

function serializeMetric(metric) {
  return {
    requests: metric.requests,
    inputTokens: metric.inputTokens,
    outputTokens: metric.outputTokens,
    cachedTokens: metric.cachedTokens,
    estimatedCost: metric.estimatedCost,
    lastUsed: metric.lastUsed,
    models: [...metric.models].sort(),
    providers: [...metric.providers].sort(),
  };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dailyBuckets(days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return { key: localDateKey(date), label: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }), requests: 0, tokens: 0, estimatedCost: 0 };
  });
}

function hourlyBuckets() {
  const current = new Date();
  current.setMinutes(0, 0, 0);
  const start = current.getTime() - 23 * 3_600_000;
  return Array.from({ length: 24 }, (_, index) => {
    const timestamp = start + index * 3_600_000;
    return {
      key: String(timestamp),
      label: new Date(timestamp).toLocaleTimeString("en-US", { hour: "numeric" }),
      requests: 0,
      tokens: 0,
      estimatedCost: 0,
    };
  });
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(",");
}

function loadSelectedHistory(db, columns, cutoff, rawKeys, latestOnly = false) {
  const rows = [];
  for (let index = 0; index < rawKeys.length; index += 800) {
    const chunk = rawKeys.slice(index, index + 800);
    rows.push(...db.all(
      `SELECT ${columns} FROM usageHistory
       WHERE timestamp >= ? AND apiKey IN (${placeholders(chunk.length)})${latestOnly ? " GROUP BY apiKey" : ""}`,
      [cutoff, ...chunk],
    ));
  }
  return rows;
}

async function computePortalUsage(period, portal, allKeys) {
  const providerNodes = await getProviderNodes().catch(() => []);
  const providerNames = new Map(providerNodes.map((node) => [node.id, node.name || node.id]));
  const displayProvider = (provider) => providerNames.get(provider) || provider || "Unknown";
  const keyById = new Map(allKeys.map((key) => [key.id, key]));
  const groups = portal.groups.map((group) => ({
    ...group,
    keys: group.apiKeyIds.map((id) => keyById.get(id)).filter(Boolean),
  }));
  const selectedKeys = groups.flatMap((group) => group.keys);
  const rawToId = new Map(selectedKeys.map((key) => [key.key, key.id]));
  const selectedRawKeys = [...rawToId.keys()];
  const perKey = new Map(selectedKeys.map((key) => [key.id, emptyMetric()]));
  const trend = period === "24h" ? hourlyBuckets() : dailyBuckets(PERIOD_DAYS[period]);
  const trendByKey = new Map(trend.map((bucket) => [bucket.key, bucket]));

  if (selectedRawKeys.length) {
    const db = await getAdapter();
    if (period === "24h") {
      const cutoff = new Date(Date.now() - 86_400_000).toISOString();
      const rows = loadSelectedHistory(
        db,
        "timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, tokens",
        cutoff,
        selectedRawKeys,
      );
      for (const row of rows) {
        const metric = perKey.get(rawToId.get(row.apiKey));
        if (!metric) continue;
        const tokens = parseJson(row.tokens, {}) || {};
        const values = {
          requests: 1,
          inputTokens: tokens.prompt_tokens ?? tokens.input_tokens ?? row.promptTokens ?? 0,
          outputTokens: tokens.completion_tokens ?? tokens.output_tokens ?? row.completionTokens ?? 0,
          cachedTokens: tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0,
          estimatedCost: row.cost || 0,
          model: row.model || "Unknown",
          provider: displayProvider(row.provider),
          lastUsed: row.timestamp,
        };
        addMetric(metric, values);
        const bucketKey = String(Math.floor(new Date(row.timestamp).getTime() / 3_600_000) * 3_600_000);
        const bucket = trendByKey.get(bucketKey) || (new Date(row.timestamp).getTime() < Number(trend[0].key) ? trend[0] : null);
        if (bucket) {
          bucket.requests += 1;
          bucket.tokens += values.inputTokens + values.outputTokens;
          bucket.estimatedCost += values.estimatedCost;
        }
      }
    } else {
      const days = PERIOD_DAYS[period];
      const cutoffDate = new Date();
      cutoffDate.setHours(0, 0, 0, 0);
      cutoffDate.setDate(cutoffDate.getDate() - days + 1);
      const cutoffKey = localDateKey(cutoffDate);
      const rows = db.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
      for (const row of rows) {
        const day = parseJson(row.data, {}) || {};
        for (const entry of Object.values(day.byApiKey || {})) {
          const keyId = rawToId.get(entry?.apiKey);
          const metric = perKey.get(keyId);
          if (!metric) continue;
          const values = {
            requests: entry.requests || 0,
            inputTokens: entry.promptTokens || 0,
            outputTokens: entry.completionTokens || 0,
            cachedTokens: entry.cachedTokens || 0,
            estimatedCost: entry.cost || 0,
            model: entry.rawModel || "Unknown",
            provider: displayProvider(entry.provider),
            lastUsed: row.dateKey,
          };
          addMetric(metric, values);
          const bucket = trendByKey.get(row.dateKey);
          if (bucket) {
            bucket.requests += values.requests;
            bucket.tokens += values.inputTokens + values.outputTokens;
            bucket.estimatedCost += values.estimatedCost;
          }
        }
      }

      const historyRows = loadSelectedHistory(db, "apiKey, MAX(timestamp) AS timestamp", cutoffDate.toISOString(), selectedRawKeys, true);
      for (const row of historyRows) {
        const metric = perKey.get(rawToId.get(row.apiKey));
        if (metric && (!metric.lastUsed || row.timestamp > metric.lastUsed)) metric.lastUsed = row.timestamp;
      }
    }
  }

  const summary = emptyMetric();
  const responseGroups = groups.map((group) => {
    const groupMetric = emptyMetric();
    const keys = group.keys.map((key) => {
      const metric = perKey.get(key.id) || emptyMetric();
      addMetric(groupMetric, {
        ...metric,
        model: null,
        provider: null,
      });
      for (const model of metric.models) groupMetric.models.add(model);
      for (const provider of metric.providers) groupMetric.providers.add(provider);
      return { id: key.id, name: key.name || "Unnamed key", active: key.isActive, ...serializeMetric(metric) };
    });
    addMetric(summary, { ...groupMetric, model: null, provider: null });
    for (const model of groupMetric.models) summary.models.add(model);
    for (const provider of groupMetric.providers) summary.providers.add(provider);
    return { id: group.id, name: group.name, keyCount: keys.length, ...serializeMetric(groupMetric), keys };
  });

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary: serializeMetric(summary),
    trend: trend.map(({ key, ...bucket }) => bucket),
    groups: responseGroups,
  };
}

export async function getPortalUsage(period) {
  const normalizedPeriod = PORTAL_PERIODS.has(period) ? period : "7d";
  const [portal, allKeys] = await Promise.all([
    getViewerPortalConfig(),
    getApiKeys(),
  ]);
  const selectedIds = new Set(portal.groups.flatMap((group) => group.apiKeyIds));
  const selectedKeyState = allKeys
    .filter((key) => selectedIds.has(key.id))
    .map(({ id, key, name, isActive }) => ({ id, key, name, isActive }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({
      groups: portal.groups.map(({ id, name, apiKeyIds }) => ({ id, name, apiKeyIds })),
      keys: selectedKeyState,
    }))
    .digest("hex")
    .slice(0, 16);
  return getCachedPortalUsage(
    `${normalizedPeriod}:${fingerprint}`,
    () => computePortalUsage(normalizedPeriod, portal, allKeys),
  );
}
