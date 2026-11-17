import { NextResponse } from "next/server";
import { updateViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export async function PATCH(request) {
  try {
    const body = await request.json();
    const portal = await updateViewerPortalConfig((current) => {
      const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
      return {
        ...current,
        enabled,
        authVersion: current.enabled && !enabled ? current.authVersion + 1 : current.authVersion,
        title: typeof body.title === "string" ? body.title : current.title,
        subtitle: typeof body.subtitle === "string" ? body.subtitle : current.subtitle,
      };
    });
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to save portal settings" }, { status: 400 });
  }
}
