"use client";
import { useEffect, useState } from "react";
import Card from "./Card";
import Badge from "./Badge";

export default function ClaudeSdkStatusCard() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let active = true;
    fetch("/api/cli-tools/claude-sdk/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => { if (active) setStatus(data); })
      .catch(() => { if (active) setStatus({ ready: false, reason: "Status check failed" }); });
    return () => { active = false; };
  }, []);
  return (
    <Card>
      <div className="flex items-center gap-3 mb-3">
        <span className="material-symbols-outlined">terminal</span>
        <p className="text-sm font-medium">Local Claude Code · Agent SDK</p>
        {status && <Badge variant={status.ready ? "success" : "error"} size="sm">{status.ready ? "Ready" : "Not ready"}</Badge>}
      </div>
      <p className="text-sm text-text-muted mb-2">
        9Router uses Claude Code's own login and executable. It does not import or store subscription OAuth credentials.
      </p>
      <code className="block text-sm p-2 rounded bg-black/5 dark:bg-white/5 break-all">{status?.loginCommand || "claude auth login"}</code>
      <p className="text-xs text-text-muted mt-2">Run this command as the same OS user, with the same HOME, that runs 9Router. It uses the exact executable selected by the SDK.</p>
      {status?.version && <p className="text-xs mt-2">Claude Code: {status.version}</p>}
      {status?.reason && <p className="text-xs text-red-500 mt-2">{status.reason}</p>}
      <p className="text-xs text-text-muted mt-2">This backend requires local Node.js processes. It is not supported on serverless hosts. Anthropic determines the usage and billing category.</p>
    </Card>
  );
}
