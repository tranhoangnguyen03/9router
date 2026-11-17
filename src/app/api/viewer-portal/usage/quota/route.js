import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { VIEWER_PORTAL_COOKIE, verifyViewerPortalToken } from "@/lib/viewerPortal/session";
import { getPortalQuota } from "@/lib/viewerPortal/quota";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const locked = () => NextResponse.json({ error: "Quota is locked" }, { status: 401, headers });

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(VIEWER_PORTAL_COOKIE)?.value;
    if (!(await verifyViewerPortalToken(token))) return locked();
    const quota = await getPortalQuota();
    if (!(await verifyViewerPortalToken(token))) return locked();
    return NextResponse.json(quota, { headers });
  } catch {
    return NextResponse.json({ error: "Quota is temporarily unavailable" }, { status: 500, headers });
  }
}
