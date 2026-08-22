import { NextResponse } from "next/server";
import { updateViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export async function PUT(request) {
  try {
    const body = await request.json();
    const portal = await updateViewerPortalConfig((current) => ({
      ...current,
      draftBoard: {
        title: typeof body.title === "string" ? body.title : "",
        body: typeof body.body === "string" ? body.body : "",
        updatedAt: new Date().toISOString(),
      },
    }));
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to save draft" }, { status: 400 });
  }
}
