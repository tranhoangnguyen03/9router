import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { updateViewerPortalConfig, toAdminPortalConfig } from "@/lib/viewerPortal/config";

export async function POST(request) {
  try {
    const body = await request.json();
    if (typeof body.password !== "string") {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }
    if (body.password && body.password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    if (body.password.length > 200) {
      return NextResponse.json({ error: "Password is too long" }, { status: 400 });
    }
    const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : null;
    const portal = await updateViewerPortalConfig((current) => ({
      ...current,
      passwordHash,
      authVersion: current.authVersion + 1,
    }));
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update password" }, { status: 400 });
  }
}
