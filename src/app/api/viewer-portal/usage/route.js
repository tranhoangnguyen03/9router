import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { VIEWER_PORTAL_COOKIE, verifyViewerPortalToken } from "@/lib/viewerPortal/session";
import { getPortalUsage, PORTAL_PERIODS } from "@/lib/viewerPortal/usage";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(VIEWER_PORTAL_COOKIE)?.value;
  if (!(await verifyViewerPortalToken(token))) {
    return NextResponse.json({ error: "Usage is locked" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const period = request.nextUrl.searchParams.get("period") || "7d";
  if (!PORTAL_PERIODS.has(period)) {
    return NextResponse.json({ error: "Unsupported period" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    return NextResponse.json(await getPortalUsage(period), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to aggregate viewer usage:", error);
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
