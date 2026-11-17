import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { getViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [portal, keys] = await Promise.all([getViewerPortalConfig(), getApiKeys()]);
    const validIds = new Set(keys.map((key) => key.id));
    const safePortal = toAdminPortalConfig(portal);
    safePortal.groups = safePortal.groups.map((group) => ({
      ...group,
      apiKeyIds: group.apiKeyIds.filter((id) => validIds.has(id)),
    }));
    return NextResponse.json({
      portal: safePortal,
      apiKeys: keys.map(({ id, name, isActive, createdAt }) => ({ id, name, isActive, createdAt })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to load portal administration:", error);
    return NextResponse.json({ error: "Failed to load portal settings" }, { status: 500 });
  }
}
