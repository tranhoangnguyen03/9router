import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { VIEWER_PORTAL_COOKIE, verifyViewerPortalToken } from "@/lib/viewerPortal/session";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(VIEWER_PORTAL_COOKIE)?.value;
  return NextResponse.json(
    { unlocked: await verifyViewerPortalToken(token) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
