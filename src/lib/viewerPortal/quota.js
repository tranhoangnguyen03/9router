import { getProviderConnections } from "@/lib/localDb";
import { AI_PROVIDERS, USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { GET as getConnectionUsage } from "@/app/api/usage/[connectionId]/route";
import { getViewerPortalConfig } from "./config.js";

const TTL_MS = 60_000;
const WAIT_MS = 15_000;
const CONCURRENCY = 4;
const ACCOUNT_WAIT_MS = 10_000;
const MAX_ENTRIES = 100;
// ponytail: upstream's handler does not propagate cancellation. Time out the
// wait, not the network call; retain its promise to prevent duplicate retries.
// At most 100 outstanding/cached accounts and four actively awaited refreshes.
// Use true cancellation if upstream exposes it, rather than patching global fetch.
const state = globalThis._forkViewerPortalQuotaCache ||= { entries: new Map(), active: 0 };

export function supportsPortalQuota(connection) {
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)
    && (connection.authType === "oauth" || (["apikey", "api_key"].includes(connection.authType) && USAGE_APIKEY_PROVIDERS.includes(connection.provider)));
}

export async function getQuotaAccounts() {
  const connections = await getProviderConnections();
  return connections.filter(supportsPortalQuota).map(({ id, name, provider, isActive }) => ({
    id, name: name || "Unnamed account", provider,
    providerName: AI_PROVIDERS[provider]?.name || provider, isActive: isActive !== false,
  }));
}

const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function date(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function sanitizeQuotas(data) {
  if (!data?.quotas || typeof data.quotas !== "object" || Array.isArray(data.quotas)) return [];
  return Object.entries(data.quotas).slice(0, 100).flatMap(([name, quota]) => {
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) return [];
    const used = number(quota.used);
    const total = number(quota.total);
    const isCreditBalance = quota.isCreditBalance === true;
    const currency = typeof quota.currency === "string" && /^[A-Z]{3}$/.test(quota.currency) ? quota.currency : null;
    const unlimited = quota.unlimited === true;
    const percentage = number(quota.remainingPercentage)
      ?? (used !== null && total > 0 ? Math.max(0, (total - used) / total * 100) : null);
    return [{
      name: name.slice(0, 120), used, total, unlimited,
      isCreditBalance, currency: isCreditBalance ? currency : null,
      remainingPercentage: isCreditBalance || unlimited || percentage === null ? null : Math.min(100, percentage),
      resetAt: isCreditBalance ? null : date(quota.resetAt), recurring: quota.recurring !== false,
    }];
  });
}

async function refreshAccount(id) {
  let entry = state.entries.get(id);
  if (entry?.pending) return entry.wait;
  if (entry?.expiresAt > Date.now() || state.active >= CONCURRENCY) return;
  if (!entry && state.entries.size >= MAX_ENTRIES) return;
  entry ||= { quotas: [], checkedAt: null, status: "updating" };
  state.entries.set(id, entry);
  state.active += 1;
  entry.pending = Promise.resolve().then(async () => {
    try {
      // Call the existing server handler, not an HTTP self-fetch. It owns provider
      // eligibility, proxy resolution and OAuth refresh/retry; never force refresh.
      const response = await getConnectionUsage(new Request("http://localhost/api/usage/portal"), {
        params: Promise.resolve({ connectionId: id }),
      });
      const data = await response.json();
      if (!response.ok || data?.error || !data?.quotas || typeof data.quotas !== "object" || Array.isArray(data.quotas)) throw new Error("Quota unavailable");
      const quotas = sanitizeQuotas(data);
      entry.quotas = quotas;
      entry.checkedAt = new Date().toISOString();
      entry.status = quotas.length ? "available" : "unavailable";
    } catch {
      entry.status = entry.quotas.length ? "stale" : "unavailable";
    } finally {
      entry.expiresAt = Date.now() + TTL_MS;
      entry.pending = null;
    }
  });
  let timer;
  entry.wait = Promise.race([
    entry.pending,
    new Promise(resolve => {
      timer = setTimeout(() => {
        entry.status = entry.quotas.length ? "stale" : "unavailable";
        resolve();
      }, ACCOUNT_WAIT_MS);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    entry.wait = null;
    state.active -= 1;
  });
  return entry.wait;
}

async function selectedAccounts() {
  const [portal, accounts] = await Promise.all([getViewerPortalConfig(), getQuotaAccounts()]);
  if (!portal.enabled || !portal.passwordHash) return [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return portal.quotaAccounts.flatMap(({ connectionId, label }, index) => {
    const account = byId.get(connectionId);
    return account ? [{ ...account, label: label || `${account.providerName} account ${index + 1}` }] : [];
  });
}

export async function getPortalQuota() {
  const selected = await selectedAccounts();
  const ids = new Set(selected.map((account) => account.id));
  for (const [id, entry] of state.entries) {
    if (!ids.has(id) && !entry.pending) state.entries.delete(id);
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
    while (next < selected.length) {
      const account = selected[next++];
      if (account.isActive) await refreshAccount(account.id);
    }
  });
  let timer;
  try {
    await Promise.race([
      Promise.all(workers),
      new Promise(resolve => { timer = setTimeout(resolve, WAIT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Re-read publication after slow work, so unpublishing/deleting an account
  // during a refresh cannot expose it in the finished response.
  const current = await selectedAccounts();
  return {
    accounts: current.map((account) => {
      const entry = account.isActive ? state.entries.get(account.id) : null;
      return {
        label: account.label, provider: account.providerName,
        status: !account.isActive ? "unavailable" : entry?.wait ? "updating" : entry?.status || "unavailable",
        checkedAt: entry?.checkedAt || null,
        quotas: entry?.quotas || [],
      };
    }),
  };
}

export const __test__ = { state };
