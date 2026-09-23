"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button, Card, Input, SegmentedControl, ThemeToggle } from "@/shared/components";
import QuotaView from "./QuotaView";
import { sortUsageGroups, totalTokens } from "./sortUsage";

const PERIODS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "60d", label: "60 days" },
];

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const TREND_METRICS = [
  { key: "tokens", label: "Tokens", color: "#E56A4A", format: (value) => formatNumber(value) },
  { key: "estimatedCost", label: "Est. cost", color: "#E0A338", format: (value) => money.format(value) },
  { key: "requests", label: "Requests", color: "#38A89A", format: (value) => formatNumber(value) },
];

function formatNumber(value) {
  return value >= 10_000 ? compact.format(value) : integer.format(value || 0);
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function SummaryCard({ icon, label, value, detail }) {
  return (
    <Card padding="sm" className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</p>
          <p className="mt-2 truncate text-2xl font-semibold tracking-tight text-text-main">{value}</p>
          <p className="mt-1 text-xs text-text-muted">{detail}</p>
        </div>
        <span className="material-symbols-outlined rounded-[10px] bg-brand-500/10 p-2 text-brand-500">{icon}</span>
      </div>
    </Card>
  );
}

function UsageChart({ data }) {
  const [metric, setMetric] = useState("tokens");
  const view = TREND_METRICS.find((item) => item.key === metric);
  const hasData = data.some((item) => item[metric] > 0);
  return (
    <Card padding="sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-text-main">Usage trend</h2>
          <p className="text-xs text-text-muted">Published keys combined</p>
        </div>
        <div role="group" aria-label="Usage trend metric" className="flex flex-wrap gap-1">
          {TREND_METRICS.map((item) => (
            <button key={item.key} type="button" aria-pressed={metric === item.key} onClick={() => setMetric(item.key)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${metric === item.key ? "bg-brand-500/10 text-brand-500" : "text-text-muted hover:bg-surface-2"}`}>{item.label}</button>
          ))}
        </div>
      </div>
      {!hasData ? (
        <div className="flex h-56 items-center justify-center text-sm text-text-muted">No {view.label.toLowerCase()} in this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="portalTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={view.color} stopOpacity={0.32} />
                <stop offset="95%" stopColor={view.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.55 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={view.format} tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.55 }} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(value) => [view.key === "tokens" || view.key === "requests" ? integer.format(value) : view.format(value), view.label]}
              contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 12 }}
            />
            <Area type="monotone" dataKey={view.key} stroke={view.color} strokeWidth={2} fill="url(#portalTokens)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function UsageGroup({ group, expanded, onToggle }) {
  return (
    <Card padding="none" className="overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-2/50 sm:p-5">
        <span className={`material-symbols-outlined text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}>expand_more</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-text-main">{group.name}</h3>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-muted">{group.keyCount} {group.keyCount === 1 ? "key" : "keys"}</span>
          </div>
          <p className="mt-1 text-xs text-text-muted">Last used {formatDate(group.lastUsed)}</p>
          <p className="mt-1 text-xs text-text-muted sm:hidden">{formatNumber(totalTokens(group))} tokens · {money.format(group.estimatedCost || 0)} est. cost</p>
        </div>
        <div className="hidden gap-8 text-right sm:flex">
          <div><p className="text-xs text-text-muted">Tokens</p><p className="font-semibold text-text-main">{formatNumber(totalTokens(group))}</p></div>
          <div><p className="text-xs text-text-muted">Requests</p><p className="font-semibold text-text-main">{formatNumber(group.requests)}</p></div>
          <div><p className="text-xs text-text-muted">Est. cost</p><p className="font-semibold text-text-main">{money.format(group.estimatedCost || 0)}</p></div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border-subtle">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead className="bg-surface-2/60 text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 font-semibold">API key</th>
                  <th className="px-4 py-3 font-semibold">Models / providers</th>
                  <th className="px-4 py-3 text-right font-semibold">Requests</th>
                  <th className="px-4 py-3 text-right font-semibold">Total tokens</th>
                  <th className="px-4 py-3 text-right font-semibold">Input</th>
                  <th className="px-4 py-3 text-right font-semibold">Output</th>
                  <th className="px-4 py-3 text-right font-semibold">Cached</th>
                  <th className="px-4 py-3 text-right font-semibold">Est. cost</th>
                  <th className="px-5 py-3 font-semibold">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {group.keys.map((key) => (
                  <tr key={key.id} className="hover:bg-surface-2/30">
                    <td className="px-5 py-4">
                      <div className="font-medium text-text-main">{key.name}</div>
                      <div className="text-xs text-text-muted sm:hidden">{formatNumber(totalTokens(key))} tokens · {money.format(key.estimatedCost || 0)} est. cost</div>
                      {!key.active && <span className="text-xs text-warning">Inactive</span>}
                    </td>
                    <td className="max-w-[260px] px-4 py-4 text-xs text-text-muted">
                      <div className="truncate" title={key.models.join(", ")}>{key.models.join(", ") || "No models"}</div>
                      <div className="mt-1 truncate" title={key.providers.join(", ")}>{key.providers.join(", ") || "No providers"}</div>
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatNumber(key.requests)}</td>
                    <td className="px-4 py-4 text-right tabular-nums" title={integer.format(totalTokens(key))}>{formatNumber(totalTokens(key))}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatNumber(key.inputTokens)}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatNumber(key.outputTokens)}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatNumber(key.cachedTokens)}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{money.format(key.estimatedCost || 0)}</td>
                    <td className="px-5 py-4 text-xs text-text-muted">{formatDate(key.lastUsed)}</td>
                  </tr>
                ))}
                {!group.keys.length && <tr><td colSpan="9" className="px-5 py-8 text-center text-text-muted">No published keys in this group</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function PortalPageClient() {
  const [portal, setPortal] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [period, setPeriod] = useState("7d");
  const [sortBy, setSortBy] = useState("published");
  const [usage, setUsage] = useState(null);
  const [tab, setTab] = useState("usage");
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/viewer-portal/public", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/viewer-portal/session/status", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([publicData, status]) => {
      setPortal(publicData);
      if (!publicData.usageAvailable && publicData.quotaAvailable) setTab("quota");
      setUnlocked(status.unlocked === true);
    }).catch(() => setError("The portal could not be loaded.")).finally(() => setLoading(false));
  }, []);

  const onLocked = useCallback(() => {
    setUnlocked(false);
    setUsage(null);
    setExpanded(null);
    setError("");
  }, []);

  const loadUsage = useCallback(async (signal) => {
    if (!unlocked || tab !== "usage" || !portal?.usageAvailable) return;
    setUsageLoading(true);
    setUsage(null);
    setError("");
    try {
      const response = await fetch(`/api/viewer-portal/usage?period=${period}`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) {
        onLocked();
        return;
      }
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Usage could not be loaded");
      setUsage(data);
      setExpanded((current) => {
        if (current === null) return new Set(data.groups[0] ? [data.groups[0].id] : []);
        const valid = new Set(data.groups.map((group) => group.id));
        const kept = new Set([...current].filter((id) => valid.has(id)));
        return kept.size || !current.size ? kept : new Set(data.groups[0] ? [data.groups[0].id] : []);
      });
    } catch (requestError) {
      if (!signal.aborted) setError(requestError.message);
    } finally {
      if (!signal.aborted) setUsageLoading(false);
    }
  }, [period, unlocked, tab, portal?.usageAvailable, onLocked]);

  useEffect(() => {
    const controller = new AbortController();
    loadUsage(controller.signal);
    return () => controller.abort();
  }, [loadUsage]);

  const unlock = async (event) => {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/viewer-portal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Unable to unlock portal");
      return;
    }
    setPassword("");
    setUnlocked(true);
  };

  const lock = async () => {
    onLocked();
    try {
      const response = await fetch("/api/viewer-portal/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Session could not be ended. Please retry Lock.");
    } catch {
      setError("Session could not be ended. Reload and retry Lock to clear the session cookie.");
    }
  };

  const summaryTokens = useMemo(() => usage ? totalTokens(usage.summary) : 0, [usage]);
  const sortedGroups = useMemo(() => usage ? sortUsageGroups(usage.groups, sortBy) : [], [usage, sortBy]);

  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-text-muted">Loading portal…</div>;

  return (
    <main className="min-h-screen bg-bg">
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-5 sm:px-6">
          <div className="flex size-10 items-center justify-center rounded-[12px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
            <span className="material-symbols-outlined text-white">hub</span>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight text-text-main">{portal?.title || "9Router"}</h1>
            {portal?.subtitle && <p className="truncate text-sm text-text-muted">{portal.subtitle}</p>}
          </div>
          {unlocked && <Button variant="ghost" size="sm" onClick={lock} icon="lock">Lock</Button>}
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        {!portal?.enabled ? (
          <Card className="py-14 text-center">
            <span className="material-symbols-outlined text-4xl text-text-muted">visibility_off</span>
            <h2 className="mt-3 text-lg font-semibold">This portal is not available</h2>
            <p className="mt-1 text-sm text-text-muted">Contact the 9Router administrator for access.</p>
          </Card>
        ) : (
          <>
            {portal.board && (
              <Card className="border-brand-500/20 bg-gradient-to-br from-brand-500/[0.08] to-surface">
                <div className="flex gap-4">
                  <span className="material-symbols-outlined mt-0.5 text-brand-500">campaign</span>
                  <div className="min-w-0">
                    {portal.board.title && <h2 className="text-lg font-semibold text-text-main">{portal.board.title}</h2>}
                    {portal.board.body && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">{portal.board.body}</p>}
                    {portal.board.publishedAt && <p className="mt-3 text-xs text-text-subtle">Published {formatDate(portal.board.publishedAt)}</p>}
                  </div>
                </div>
              </Card>
            )}

            {!portal.usageAvailable && !portal.quotaAvailable ? (
              <Card className="text-center"><p className="text-sm text-text-muted">Protected usage and quota have not been configured.</p></Card>
            ) : !unlocked ? (
              <Card className="mx-auto w-full max-w-md" elev>
                <div className="mb-5 text-center">
                  <span className="material-symbols-outlined rounded-full bg-brand-500/10 p-3 text-2xl text-brand-500">lock</span>
                  <h2 className="mt-3 text-lg font-semibold">Unlock viewer portal</h2>
                  <p className="mt-1 text-sm text-text-muted">Enter the shared viewer password.</p>
                </div>
                <form onSubmit={unlock} className="space-y-4">
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} label="Viewer password" aria-label="Viewer password" autoComplete="current-password" required />
                  {error && <p className="text-sm text-danger">{error}</p>}
                  <Button type="submit" fullWidth disabled={!password}>Unlock portal</Button>
                </form>
              </Card>
            ) : (
              <div className="flex flex-col gap-5">
                <SegmentedControl aria-label="Viewer portal view" options={[{ value: "usage", label: "Usage" }, { value: "quota", label: "Quota" }]} value={tab} onChange={setTab} className="w-full sm:w-fit" />
                {tab === "quota" ? <QuotaView onLocked={onLocked} /> : !portal.usageAvailable ? (
                  <Card className="text-center text-sm text-text-muted">No usage groups have been published.</Card>
                ) : <section className="flex flex-col gap-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">Published usage</h2>
                    <p className="text-sm text-text-muted">Aggregates only · Updated {formatDate(usage?.generatedAt)}</p>
                  </div>
                  <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" className="w-full sm:w-auto" />
                </div>
                {error && <div className="rounded-[10px] border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}
                {usageLoading && !usage ? (
                  <Card className="py-16 text-center text-sm text-text-muted">Computing usage…</Card>
                ) : usage ? (
                  <>
                    <div className="grid gap-3 md:grid-cols-3">
                      <SummaryCard icon="send" label="Requests" value={formatNumber(usage.summary.requests)} detail={`${usage.summary.models.length} models · ${usage.summary.providers.length} providers`} />
                      <SummaryCard icon="token" label="Tokens" value={formatNumber(summaryTokens)} detail={`${formatNumber(usage.summary.inputTokens)} in · ${formatNumber(usage.summary.outputTokens)} out · ${formatNumber(usage.summary.cachedTokens)} cached`} />
                      <SummaryCard icon="payments" label="Estimated cost" value={money.format(usage.summary.estimatedCost || 0)} detail={`Last used ${formatDate(usage.summary.lastUsed)}`} />
                    </div>
                    <UsageChart data={usage.trend} />
                    <div className="space-y-3">
                      <label className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                        Sort groups and keys
                        <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-text-main">
                          <option value="published">Published order</option>
                          <option value="tokens">Most tokens</option>
                          <option value="cost">Highest estimated cost</option>
                        </select>
                      </label>
                      {sortedGroups.map((group) => (
                        <UsageGroup
                          key={group.id}
                          group={group}
                          expanded={expanded?.has(group.id) || false}
                          onToggle={() => setExpanded((current) => {
                            const next = new Set(current || []);
                            if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                            return next;
                          })}
                        />
                      ))}
                    </div>
                  </>
                ) : null}
              </section>}
              </div>
            )}
          </>
        )}
        <footer className="py-4 text-center text-xs text-text-subtle">Powered by 9Router</footer>
      </div>
    </main>
  );
}
