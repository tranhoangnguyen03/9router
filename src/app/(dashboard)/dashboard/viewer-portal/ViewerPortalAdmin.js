"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Input, SegmentedControl } from "@/shared/components";
import QuotaTab from "./QuotaTab";

const TABS = [
  { value: "general", label: "General" },
  { value: "board", label: "Announcement board" },
  { value: "groups", label: "Usage groups" },
  { value: "quota", label: "Quota" },
];

function Notice({ notice }) {
  if (!notice) return null;
  return (
    <div className={`rounded-[10px] border px-4 py-3 text-sm ${notice.type === "error" ? "border-danger/20 bg-danger/5 text-danger" : "border-success/20 bg-success/5 text-success"}`}>
      {notice.text}
    </div>
  );
}

function FieldLabel({ children, hint }) {
  return (
    <div className="mb-1.5">
      <p className="text-sm font-medium text-text-main">{children}</p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function Switch({ checked, onChange, label, description }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-5 text-left">
      <span><span className="block text-sm font-medium text-text-main">{label}</span><span className="mt-0.5 block text-xs text-text-muted">{description}</span></span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand-500" : "bg-surface-3"}`}>
        <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </span>
    </button>
  );
}

function GeneralTab({ portal, setPortal, saveGeneral, busy, setNotice }) {
  const [password, setPassword] = useState("");
  const [portalUrl, setPortalUrl] = useState("/portal");
  useEffect(() => setPortalUrl(`${window.location.origin}/portal`), []);

  const updatePassword = async (remove = false) => {
    setNotice(null);
    const response = await fetch("/api/viewer-portal/admin/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: remove ? "" : password }),
    });
    const data = await response.json();
    if (!response.ok) return setNotice({ type: "error", text: data.error || "Password could not be updated" });
    setPortal(data.portal);
    setPassword("");
    setNotice({ type: "success", text: remove ? "Viewer password removed. Usage and quota are now unavailable." : "Viewer password updated. Existing viewer sessions were ended." });
  };

  const copyUrl = async () => {
    await navigator.clipboard.writeText(portalUrl);
    setNotice({ type: "success", text: "Portal URL copied." });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <Card title="Portal availability" subtitle="The public announcement and protected usage/quota share one page.">
          <Switch checked={portal.enabled} onChange={(enabled) => setPortal((current) => ({ ...current, enabled }))} label="Enable viewer portal" description="When disabled, visitors see an unavailable page." />
          <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-5 sm:flex-row">
            <div className="min-w-0 flex-1 rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-xs text-text-muted"><span className="block truncate">{portalUrl}</span></div>
            <Button variant="secondary" icon="content_copy" onClick={copyUrl}>Copy URL</Button>
            <Button variant="outline" icon="open_in_new" onClick={() => window.open("/portal", "_blank", "noopener,noreferrer")}>Preview</Button>
          </div>
        </Card>

        <Card title="Portal identity" subtitle="Presented in the existing 9Router visual style.">
          <div className="space-y-4">
            <Input label="Title" value={portal.title} maxLength={120} onChange={(event) => setPortal((current) => ({ ...current, title: event.target.value }))} />
            <Input label="Subtitle" value={portal.subtitle} maxLength={240} onChange={(event) => setPortal((current) => ({ ...current, subtitle: event.target.value }))} placeholder="A short description for viewers" />
            <Button onClick={saveGeneral} loading={busy}>Save general settings</Button>
          </div>
        </Card>
      </div>

      <Card title="Viewer password" subtitle="Separate from dashboard authentication." className="h-fit">
        <div className="space-y-4">
          <div className={`rounded-[10px] px-3 py-2 text-sm ${portal.hasPassword ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
            {portal.hasPassword ? "Password configured" : "No password — usage and quota unavailable"}
          </div>
          <Input type="password" label={portal.hasPassword ? "New password" : "Set password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={200} autoComplete="new-password" hint="At least 8 characters. Updating it ends existing viewer sessions." />
          <Button fullWidth onClick={() => updatePassword(false)} disabled={password.length < 8}>Save password</Button>
          {portal.hasPassword && <Button fullWidth variant="ghost" onClick={() => updatePassword(true)}>Remove password</Button>}
        </div>
      </Card>
    </div>
  );
}

function BoardPreview({ board }) {
  if (!board?.title && !board?.body) return <p className="py-8 text-center text-sm text-text-muted">The board is empty.</p>;
  return (
    <div className="rounded-[14px] border border-brand-500/20 bg-gradient-to-br from-brand-500/[0.08] to-surface p-5">
      <div className="flex gap-3">
        <span className="material-symbols-outlined text-brand-500">campaign</span>
        <div>{board.title && <h3 className="font-semibold">{board.title}</h3>}<p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">{board.body}</p></div>
      </div>
    </div>
  );
}

function BoardTab({ portal, setPortal, setNotice }) {
  const [draft, setDraft] = useState(portal.draftBoard || { title: "", body: "" });
  const [busy, setBusy] = useState("");

  useEffect(() => setDraft(portal.draftBoard || { title: "", body: "" }), [portal.draftBoard]);

  const request = async (path, method, body) => {
    setBusy(path);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Announcement could not be updated");
      setPortal(data.portal);
      setNotice({ type: "success", text: path.endsWith("unpublish") ? "Announcement unpublished." : path.endsWith("publish") ? "Announcement published and replaced the previous board." : "Draft saved." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally {
      setBusy("");
    }
  };

  const saveDraft = () => request("/api/viewer-portal/admin/board/draft", "PUT", draft);
  const publish = () => request("/api/viewer-portal/admin/board/publish", "POST", draft);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <Card title="Announcement draft" subtitle="Plain text with preserved line breaks. Saving does not change the live board.">
        <div className="space-y-4">
          <Input label="Title" value={draft.title} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Service update" />
          <div>
            <FieldLabel hint={`${draft.body.length.toLocaleString()} / 10,000 characters`}>Message</FieldLabel>
            <textarea value={draft.body} maxLength={10_000} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} rows={10} className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main outline-none transition focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30 sm:text-sm" placeholder="Write the announcement shown to every portal visitor…" />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={saveDraft} loading={busy.includes("draft")}>Save draft</Button>
            <Button icon="publish" onClick={publish} loading={busy.endsWith("publish") && !busy.endsWith("unpublish")} disabled={!draft.title.trim() && !draft.body.trim()}>Publish and replace</Button>
            {portal.publishedBoard && <Button variant="ghost" onClick={() => request("/api/viewer-portal/admin/board/unpublish", "POST")} loading={busy.includes("unpublish")}>Unpublish</Button>}
          </div>
        </div>
      </Card>

      <div className="space-y-5">
        <Card title="Draft preview"><BoardPreview board={draft} /></Card>
        <Card title="Live board" subtitle={portal.publishedBoard?.publishedAt ? `Published ${new Date(portal.publishedBoard.publishedAt).toLocaleString()}` : "Nothing is currently published."}>
          <BoardPreview board={portal.publishedBoard} />
        </Card>
      </div>
    </div>
  );
}

function move(items, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function GroupsTab({ portal, apiKeys, setPortal, setNotice }) {
  const [groups, setGroups] = useState(portal.groups || []);
  const [expanded, setExpanded] = useState(new Set(portal.groups?.[0] ? [portal.groups[0].id] : []));
  const [busy, setBusy] = useState(false);
  useEffect(() => setGroups(portal.groups || []), [portal.groups]);

  const assigned = useMemo(() => {
    const map = new Map();
    for (const group of groups) for (const keyId of group.apiKeyIds) map.set(keyId, group.id);
    return map;
  }, [groups]);
  const privateCount = apiKeys.filter((key) => !assigned.has(key.id)).length;

  const updateGroup = (id, transform) => setGroups((current) => current.map((group) => group.id === id ? transform(group) : group));
  const addGroup = () => {
    const id = crypto.randomUUID();
    setGroups((current) => [...current, { id, name: `Group ${current.length + 1}`, apiKeyIds: [] }]);
    setExpanded((current) => new Set([...current, id]));
  };
  const removeGroup = (id) => setGroups((current) => current.filter((group) => group.id !== id));
  const toggleKey = (groupId, keyId) => updateGroup(groupId, (group) => ({
    ...group,
    apiKeyIds: group.apiKeyIds.includes(keyId) ? group.apiKeyIds.filter((id) => id !== keyId) : [...group.apiKeyIds, keyId],
  }));
  const moveKey = (groupId, keyId, direction) => updateGroup(groupId, (group) => {
    const index = group.apiKeyIds.indexOf(keyId);
    return { ...group, apiKeyIds: move(group.apiKeyIds, index, direction) };
  });

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/viewer-portal/admin/groups", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groups }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Groups could not be saved");
      setPortal(data.portal);
      setNotice({ type: "success", text: "Published usage groups saved. Cached summaries were invalidated." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card padding="sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="font-semibold">Published groups</h2><p className="text-sm text-text-muted">{groups.length} groups · {assigned.size} published keys · {privateCount} private keys</p></div>
          <div className="flex flex-wrap gap-3"><Button variant="outline" icon="visibility" onClick={() => window.open("/portal", "_blank", "noopener,noreferrer")}>Preview</Button><Button variant="secondary" icon="add" onClick={addGroup}>Add group</Button><Button onClick={save} loading={busy}>Save groups</Button></div>
        </div>
      </Card>

      {groups.map((group, groupIndex) => {
        const open = expanded.has(group.id);
        const selectedKeys = group.apiKeyIds.map((id) => apiKeys.find((key) => key.id === id)).filter(Boolean);
        return (
          <Card key={group.id} padding="none" className="overflow-hidden">
            <div className="flex items-center gap-2 p-4 sm:p-5">
              <button type="button" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} className="rounded p-1 text-text-muted hover:bg-surface-2">
                <span className={`material-symbols-outlined transition-transform ${open ? "rotate-180" : ""}`}>expand_more</span>
              </button>
              <input value={group.name} maxLength={80} onChange={(event) => updateGroup(group.id, (current) => ({ ...current, name: event.target.value }))} className="min-w-0 flex-1 rounded-[8px] border border-transparent bg-transparent px-2 py-1 font-semibold outline-none hover:border-border focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/20" aria-label="Group name" />
              <span className="hidden rounded-full bg-surface-2 px-2 py-1 text-xs text-text-muted sm:inline">{selectedKeys.length} keys</span>
              <button type="button" disabled={groupIndex === 0} onClick={() => setGroups((current) => move(current, groupIndex, -1))} className="rounded p-1 text-text-muted hover:bg-surface-2 disabled:opacity-25" title="Move group up"><span className="material-symbols-outlined text-[20px]">arrow_upward</span></button>
              <button type="button" disabled={groupIndex === groups.length - 1} onClick={() => setGroups((current) => move(current, groupIndex, 1))} className="rounded p-1 text-text-muted hover:bg-surface-2 disabled:opacity-25" title="Move group down"><span className="material-symbols-outlined text-[20px]">arrow_downward</span></button>
              <button type="button" onClick={() => removeGroup(group.id)} className="rounded p-1 text-text-muted hover:bg-danger/10 hover:text-danger" title="Delete group"><span className="material-symbols-outlined text-[20px]">delete</span></button>
            </div>
            {open && (
              <div className="grid gap-5 border-t border-border-subtle p-4 lg:grid-cols-2 sm:p-5">
                <div>
                  <FieldLabel hint="A key assigned elsewhere is unavailable here.">Available API keys</FieldLabel>
                  <div className="max-h-80 space-y-1 overflow-y-auto rounded-[10px] border border-border-subtle p-2">
                    {apiKeys.map((key) => {
                      const owner = assigned.get(key.id);
                      const selected = owner === group.id;
                      const disabled = Boolean(owner && owner !== group.id);
                      return (
                        <label key={key.id} className={`flex items-center gap-3 rounded-[8px] px-3 py-2 text-sm ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-surface-2"}`}>
                          <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleKey(group.id, key.id)} className="accent-brand-500" />
                          <span className="min-w-0 flex-1 truncate">{key.name || "Unnamed key"}</span>
                          {!key.isActive && <span className="text-xs text-warning">Inactive</span>}
                          {disabled && <span className="text-xs text-text-muted">Assigned</span>}
                        </label>
                      );
                    })}
                    {!apiKeys.length && <p className="p-4 text-center text-sm text-text-muted">No API keys exist yet.</p>}
                  </div>
                </div>
                <div>
                  <FieldLabel hint="This order is used in the viewer table.">Keys in this group</FieldLabel>
                  <div className="space-y-1 rounded-[10px] border border-border-subtle p-2">
                    {selectedKeys.map((key, keyIndex) => (
                      <div key={key.id} className="flex items-center gap-2 rounded-[8px] bg-surface-2/60 px-3 py-2 text-sm">
                        <span className="material-symbols-outlined text-[18px] text-text-muted">key</span><span className="min-w-0 flex-1 truncate">{key.name}</span>
                        <button type="button" disabled={keyIndex === 0} onClick={() => moveKey(group.id, key.id, -1)} className="text-text-muted disabled:opacity-25"><span className="material-symbols-outlined text-[18px]">arrow_upward</span></button>
                        <button type="button" disabled={keyIndex === selectedKeys.length - 1} onClick={() => moveKey(group.id, key.id, 1)} className="text-text-muted disabled:opacity-25"><span className="material-symbols-outlined text-[18px]">arrow_downward</span></button>
                        <button type="button" onClick={() => toggleKey(group.id, key.id)} className="text-text-muted hover:text-danger"><span className="material-symbols-outlined text-[18px]">close</span></button>
                      </div>
                    ))}
                    {!selectedKeys.length && <p className="p-4 text-center text-sm text-text-muted">No keys selected.</p>}
                  </div>
                </div>
              </div>
            )}
          </Card>
        );
      })}
      {!groups.length && <Card className="py-14 text-center"><span className="material-symbols-outlined text-4xl text-text-muted">group_work</span><p className="mt-3 text-sm text-text-muted">Create a group to publish selected API-key usage.</p><Button className="mt-5" icon="add" onClick={addGroup}>Create first group</Button></Card>}
    </div>
  );
}

export default function ViewerPortalAdmin() {
  const [tab, setTab] = useState("general");
  const [portal, setPortal] = useState(null);
  const [apiKeys, setApiKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    fetch("/api/viewer-portal/admin", { cache: "no-store" })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; })
      .then((data) => { setPortal(data.portal); setApiKeys(data.apiKeys); })
      .catch((error) => setNotice({ type: "error", text: error.message || "Portal settings could not be loaded" }))
      .finally(() => setLoading(false));
  }, []);

  const saveGeneral = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/viewer-portal/admin/general", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: portal.enabled, title: portal.title, subtitle: portal.subtitle }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Settings could not be saved");
      setPortal(data.portal);
      setNotice({ type: "success", text: "General portal settings saved." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="py-16 text-center text-sm text-text-muted">Loading viewer portal settings…</Card>;
  if (!portal) return <Notice notice={notice || { type: "error", text: "Portal settings are unavailable." }} />;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-500">Sharing</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Viewer Portal</h1><p className="mt-1 text-sm text-text-muted">Public announcements, password-protected usage and global quota.</p></div>
        <Button variant="outline" icon="visibility" onClick={() => window.open("/portal", "_blank", "noopener,noreferrer")}>Open viewer portal</Button>
      </div>
      <SegmentedControl options={TABS} value={tab} onChange={(value) => { setTab(value); setNotice(null); }} className="w-full sm:w-fit" />
      <Notice notice={notice} />
      {tab === "general" && <GeneralTab portal={portal} setPortal={setPortal} saveGeneral={saveGeneral} busy={busy} setNotice={setNotice} />}
      {tab === "board" && <BoardTab portal={portal} setPortal={setPortal} setNotice={setNotice} />}
      {tab === "groups" && <GroupsTab portal={portal} apiKeys={apiKeys} setPortal={setPortal} setNotice={setNotice} />}
      {tab === "quota" && <QuotaTab key={JSON.stringify(portal.quotaAccounts)} portal={portal} setPortal={setPortal} setNotice={setNotice} />}
    </div>
  );
}
