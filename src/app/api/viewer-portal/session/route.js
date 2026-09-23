import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { getViewerPortalConfig } from "@/lib/viewerPortal/config";
import {
  VIEWER_PORTAL_COOKIE,
  clearViewerPortalCookie,
  setViewerPortalCookie,
} from "@/lib/viewerPortal/session";
import {
  checkPortalLoginLock,
  clearPortalLoginFailures,
  getPortalLoginBucket,
  recordPortalLoginFailure,
} from "@/lib/viewerPortal/limiter";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  try {
    const bucket = getPortalLoginBucket(request);
    const lock = checkPortalLoginLock(bucket);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(lock.retryAfter) } },
      );
    }

    const portal = await getViewerPortalConfig();
    if (!portal.enabled || !portal.passwordHash) {
      return NextResponse.json({ error: "Protected usage is unavailable" }, { status: 403, headers: NO_STORE });
    }
    const body = await request.json();
    const candidate = typeof body?.password === "string" && body.password.length <= 200 ? body.password : "";
    const valid = Boolean(candidate) && await bcrypt.compare(candidate, portal.passwordHash);
    if (!valid) {
      const nextLock = recordPortalLoginFailure(bucket);
      if (nextLock.locked) {
        return NextResponse.json(
          { error: `Too many attempts. Try again in ${nextLock.retryAfter}s.`, retryAfter: nextLock.retryAfter },
          { status: 429, headers: { ...NO_STORE, "Retry-After": String(nextLock.retryAfter) } },
        );
      }
      return NextResponse.json({ error: "Incorrect password" }, { status: 401, headers: NO_STORE });
    }

    clearPortalLoginFailures(bucket);
    const cookieStore = await cookies();
    await setViewerPortalCookie(cookieStore, request, portal.authVersion);
    return NextResponse.json({ unlocked: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("Viewer portal login failed:", error);
    return NextResponse.json({ error: "Unable to unlock usage" }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  clearViewerPortalCookie(cookieStore);
  return NextResponse.json({ unlocked: false }, { headers: NO_STORE });
}
