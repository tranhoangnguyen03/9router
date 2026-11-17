import { NextResponse } from "next/server";
import { updateViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export async function POST() {
  try {
    const portal = await updateViewerPortalConfig((current) => ({ ...current, publishedBoard: null }));
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to unpublish announcement" }, { status: 400 });
  }
}
