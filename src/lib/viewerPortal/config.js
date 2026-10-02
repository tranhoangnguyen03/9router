import { v4 as uuidv4 } from "uuid";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol";

export const DEFAULT_VIEWER_PORTAL = Object.freeze({
  enabled: false,
  title: "9Router",
  subtitle: "",
  passwordHash: null,
  authVersion: 0,
  draftBoard: { title: "", body: "", updatedAt: null },
  publishedBoard: null,
  groups: [],
  quotaAccounts: [],
  updatedAt: null,
});

const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

function normalizeBoard(value, published = false) {
  if (!value || typeof value !== "object") return published ? null : { ...DEFAULT_VIEWER_PORTAL.draftBoard };
  const title = text(value.title, 120);
  const body = text(value.body, 10_000);
  if (published && !title && !body) return null;
  return {
    title,
    body,
    ...(published
      ? { publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null }
      : { updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null }),
  };
}

export function normalizePortalConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const assigned = new Set();
  const groupIds = new Set();
  const groups = Array.isArray(source.groups) ? source.groups.map((group) => {
    let id = text(group?.id, 100) || uuidv4();
    if (groupIds.has(id)) id = uuidv4();
    groupIds.add(id);
    const apiKeyIds = [];
    for (const keyId of Array.isArray(group?.apiKeyIds) ? group.apiKeyIds : []) {
      if (typeof keyId !== "string" || !keyId || assigned.has(keyId)) continue;
      assigned.add(keyId);
      apiKeyIds.push(keyId.slice(0, 100));
    }
    return { id, name: text(group?.name, 80) || "Untitled group", apiKeyIds };
  }) : [];

  return {
    enabled: source.enabled === true,
    title: text(source.title, 120) || DEFAULT_VIEWER_PORTAL.title,
    subtitle: text(source.subtitle, 240),
    passwordHash: typeof source.passwordHash === "string" && source.passwordHash ? source.passwordHash : null,
    authVersion: Number.isSafeInteger(source.authVersion) && source.authVersion >= 0 ? source.authVersion : 0,
    draftBoard: normalizeBoard(source.draftBoard, false),
    publishedBoard: normalizeBoard(source.publishedBoard, true),
    groups,
    quotaAccounts: (Array.isArray(source.quotaAccounts) ? source.quotaAccounts : [])
      .filter((account, index, accounts) => typeof account?.connectionId === "string" && account.connectionId.length > 0 && account.connectionId.length <= 100
        && accounts.findIndex((other) => other?.connectionId === account.connectionId) === index)
      .slice(0, 100)
      .map((account) => ({ connectionId: account.connectionId, label: text(account.label, 80) })),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

export function validateAndNormalizeGroups(value, validApiKeyIds) {
  if (!Array.isArray(value)) throw new Error("Groups must be an array");
  if (value.length > 100) throw new Error("At most 100 groups may be published");
  const assigned = new Set();
  const groupIds = new Set();

  return value.map((group) => {
    const id = text(group?.id, 100) || uuidv4();
    const name = text(group?.name, 80);
    if (!name) throw new Error("Every group needs a name");
    if (groupIds.has(id)) throw new Error("Group IDs must be unique");
    groupIds.add(id);

    const apiKeyIds = [];
    for (const apiKeyId of Array.isArray(group?.apiKeyIds) ? group.apiKeyIds : []) {
      if (typeof apiKeyId !== "string" || !validApiKeyIds.has(apiKeyId)) continue;
      if (assigned.has(apiKeyId)) throw new Error("An API key can belong to only one published group");
      assigned.add(apiKeyId);
      apiKeyIds.push(apiKeyId);
    }
    return { id, name, apiKeyIds };
  });
}

export function validateAndNormalizeQuotaAccounts(value, validConnectionIds) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Select at most 100 quota accounts");
  const selected = new Set();
  return value.map((account) => {
    const id = account?.connectionId;
    if (typeof id !== "string" || id.length > 100 || !validConnectionIds.has(id)) throw new Error("Select an existing quota-supported account");
    if (selected.has(id)) throw new Error("Quota accounts must be unique");
    if (account.label != null && (typeof account.label !== "string" || account.label.length > 80)) throw new Error("Public labels must be at most 80 characters");
    selected.add(id);
    return { connectionId: id, label: text(account.label, 80) };
  });
}

export async function getViewerPortalConfig() {
  const settings = await getSettings();
  return normalizePortalConfig(
    settings.forkExtensions?.viewerPortal ?? settings.viewerPortal,
  );
}

export async function updateViewerPortalConfig(transform) {
  const db = await getAdapter();
  let nextPortal;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    const portal = normalizePortalConfig(
      current.forkExtensions?.viewerPortal ?? current.viewerPortal,
    );
    const transformed = transform(portal);
    nextPortal = normalizePortalConfig({
      ...transformed,
      updatedAt: new Date().toISOString(),
    });
    const next = {
      ...current,
      forkExtensions: {
        ...(current.forkExtensions && typeof current.forkExtensions === "object" ? current.forkExtensions : {}),
        viewerPortal: nextPortal,
      },
    };
    // One-time cleanup for archives produced before the fork namespace was adopted.
    delete next.viewerPortal;
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return nextPortal;
}

export function toAdminPortalConfig(config) {
  const { passwordHash, ...safe } = normalizePortalConfig(config);
  delete safe.authVersion;
  return { ...safe, hasPassword: Boolean(passwordHash) };
}

export function toPublicPortalConfig(config) {
  const portal = normalizePortalConfig(config);
  return {
    enabled: portal.enabled,
    title: portal.title,
    subtitle: portal.subtitle,
    board: portal.enabled ? portal.publishedBoard : null,
    usageAvailable: portal.enabled && Boolean(portal.passwordHash) && portal.groups.some((group) => group.apiKeyIds.length > 0),
    quotaAvailable: portal.enabled && Boolean(portal.passwordHash) && portal.quotaAccounts.length > 0,
  };
}
