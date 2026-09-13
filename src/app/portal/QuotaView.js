"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const date = (value) => value ? new Date(value).toLocaleString() : "Not yet available";

export default function QuotaView({ onLocked }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    setReload(value => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    fetch("/api/viewer-portal/usage/quota", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        if (response.status === 401) { onLocked(); return; }
        if (!response.ok) throw new Error("Quota could not be loaded. Please try again.");
        const result = await response.json();
        if (!controller.signal.aborted) setData(result);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(refresh, 60_000);
        }
      });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [reload, onLocked, refresh]);

  return (
    <section className="space-y-5" aria-label="Global quota">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Global quota</h2>
          <p className="text-sm text-text-muted">Shared provider capacity · Same view for everyone</p>
          <p className="mt-1 text-xs text-text-muted">Checks refresh every minute. Providers may return cached readings.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon="refresh">{loading ? "Checking…" : "Refresh"}</Button>
      </div>
      {error && <p role="alert" className="rounded-[10px] bg-danger/10 p-3 text-sm text-danger">{error} {data ? "Previously displayed readings may be stale." : ""}</p>}
      {loading && !data && <Card className="py-12 text-center text-text-muted" role="status">Checking provider quotas…</Card>}
      {data?.accounts.length === 0 && <Card className="py-12 text-center text-text-muted">No quota accounts have been published.</Card>}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.accounts.map((account, index) => (
          <Card key={index} padding="sm">
            <h3 className="font-semibold text-text-main">{account.label}</h3>
            <p className="text-xs text-text-muted">{account.provider}</p>
            <p className="mt-1 text-xs text-text-muted">Last checked: {date(account.checkedAt)}</p>
            {account.status !== "available" && <p className="mt-3 text-sm text-warning">{account.status === "stale" ? "Stale — latest check failed" : account.status === "updating" ? "Updating — readings may be stale" : "Quota unavailable"}</p>}
            <div className="mt-4 space-y-4">
              {account.quotas.map((quota, quotaIndex) => (
                <div key={quotaIndex} className="space-y-1.5">
                  <div className="flex items-start justify-between gap-3 text-sm">
                    <span className="break-words font-medium">{quota.name}</span>
                    <span className="shrink-0 tabular-nums">{quota.unlimited ? "Unlimited" : quota.remainingPercentage === null ? "Unknown" : `${number.format(quota.remainingPercentage)}% remaining`}</span>
                  </div>
                  {!quota.unlimited && quota.remainingPercentage !== null && <progress aria-label={`${quota.name} remaining`} value={quota.remainingPercentage} max={100} className="h-2 w-full accent-brand-500" />}
                  <p className="text-xs text-text-muted">{quota.used === null ? "Unknown" : number.format(quota.used)} used{!quota.unlimited && quota.total !== null ? ` / ${number.format(quota.total)}` : ""}</p>
                  <p className="text-xs text-text-muted">{quota.recurring ? "Resets" : "Expires"}: {quota.resetAt ? date(quota.resetAt) : "Unknown"}</p>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
