import { NextResponse } from "next/server";
import { updateViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export async function POST(request) {
  try {
    let body = null;
    try { body = await request.json(); } catch {}
    const portal = await updateViewerPortalConfig((current) => {
      const draftBoard = body && typeof body === "object" ? {
        title: typeof body.title === "string" ? body.title : "",
        body: typeof body.body === "string" ? body.body : "",
        updatedAt: new Date().toISOString(),
      } : current.draftBoard;
      if (!draftBoard.title.trim() && !draftBoard.body.trim()) {
        throw new Error("Write an announcement before publishing");
      }
      return {
        ...current,
        draftBoard,
        publishedBoard: {
          title: draftBoard.title,
          body: draftBoard.body,
          publishedAt: new Date().toISOString(),
        },
      };
    });
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to publish announcement" }, { status: 400 });
  }
}
