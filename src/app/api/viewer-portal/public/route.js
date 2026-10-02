import { NextResponse } from "next/server";
import { getViewerPortalConfig, toPublicPortalConfig } from "@/lib/viewerPortal/config";
import { getApiKeys } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [portal, keys] = await Promise.all([getViewerPortalConfig(), getApiKeys()]);
    const publicPortal = toPublicPortalConfig(portal);
    const validIds = new Set(keys.map((key) => key.id));
    publicPortal.usageAvailable = publicPortal.usageAvailable
      && portal.groups.some((group) => group.apiKeyIds.some((id) => validIds.has(id)));
    return NextResponse.json(publicPortal, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to load viewer portal:", error);
    return NextResponse.json({ error: "Failed to load viewer portal" }, { status: 500 });
  }
}
