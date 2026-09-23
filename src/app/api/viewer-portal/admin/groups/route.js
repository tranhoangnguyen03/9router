import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { clearPortalUsageCache } from "@/lib/viewerPortal/cache";
import {
  toAdminPortalConfig,
  updateViewerPortalConfig,
  validateAndNormalizeGroups,
} from "@/lib/viewerPortal/config";

export async function PUT(request) {
  try {
    const [body, keys] = await Promise.all([request.json(), getApiKeys()]);
    const validIds = new Set(keys.map((key) => key.id));
    const groups = validateAndNormalizeGroups(body.groups, validIds);
    const portal = await updateViewerPortalConfig((current) => ({ ...current, groups }));
    clearPortalUsageCache();
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to save groups" }, { status: 400 });
  }
}
