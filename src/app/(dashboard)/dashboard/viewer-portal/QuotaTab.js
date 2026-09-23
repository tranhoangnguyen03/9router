"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";

export default function QuotaTab({ portal, setPortal, setNotice }) {
  const [accounts, setAccounts] = useState(null);
  const [selected, setSelected] = useState(portal.quotaAccounts || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/viewer-portal/admin/quota", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Quota accounts could not be loaded. Reopen this tab to retry.");
        const data = await response.json();
        if (controller.signal.aborted) return;
        setAccounts(data.accounts);
        const valid = new Set(data.accounts.map(account => account.id));
        setSelected(current => current.filter(account => valid.has(account.connectionId)));
        setRemoved((portal.quotaAccounts || []).some(account => !valid.has(account.connectionId)));
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [portal.quotaAccounts]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/viewer-portal/admin/quota", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaAccounts: selected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Quota accounts could not be saved");
      setPortal(data.portal);
      setNotice({ type: "success", text: "Quota selection saved. Every authenticated viewer sees these accounts." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Published quota accounts" subtitle="Global provider capacity, separate from usage groups. Protected by the same viewer password.">
      <p className="mb-4 text-sm text-text-muted">Select accounts to publish. Account names below are admin-only; viewers see your public label or a generated provider label.</p>
      {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
      {removed && <p className="mb-4 text-sm text-warning">Deleted or unsupported accounts were omitted from this selection. Save to confirm.</p>}
      {!accounts && !error && <p className="text-sm text-text-muted">Loading accounts…</p>}
      {accounts?.length === 0 && <p className="text-sm text-text-muted">No accounts supported by upstream quota tracking are connected.</p>}
      <div className="space-y-3">
        {accounts?.map(account => {
          const published = selected.find(item => item.connectionId === account.id);
          return (
            <div key={account.id} className="rounded-[10px] border border-border-subtle p-4">
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={Boolean(published)} disabled={busy} className="accent-brand-500" onChange={event => setSelected(current => event.target.checked ? [...current, { connectionId: account.id, label: "" }] : current.filter(item => item.connectionId !== account.id))} />
                <span className="min-w-0 flex-1 break-words text-sm font-medium">{account.name}<span className="ml-2 font-normal text-text-muted">{account.providerName}</span></span>
                {!account.isActive && <span className="text-xs text-warning">Inactive · quota unavailable</span>}
              </label>
              {published && <div className="mt-3"><Input label={`Public label for ${account.name}`} aria-label={`Public label for ${account.name}`} value={published.label} maxLength={80} disabled={busy} placeholder={`${account.providerName} account ${selected.indexOf(published) + 1}`} hint="Optional. Do not put private emails or credentials here." onChange={event => setSelected(current => current.map(item => item.connectionId === account.id ? { ...item, label: event.target.value } : item))} /></div>}
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={busy} disabled={!accounts}>Save quota selection</Button>
        <span className="text-sm text-text-muted">{selected.length} published accounts</span>
      </div>
    </Card>
  );
}
