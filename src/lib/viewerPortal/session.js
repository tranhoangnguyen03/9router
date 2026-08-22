import { SignJWT, jwtVerify } from "jose";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { getViewerPortalConfig } from "./config.js";

export const VIEWER_PORTAL_COOKIE = "9r_viewer_portal_session";

function loadSecret() {
  const file = path.join(DATA_DIR, "fork-viewer-portal-jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const value = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

const SECRET = new TextEncoder().encode(loadSecret());

export async function createViewerPortalToken(authVersion) {
  return new SignJWT({ portal: true, authVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

export async function verifyViewerPortalToken(token) {
  if (!token) return false;
  try {
    const [{ payload }, portal] = await Promise.all([
      jwtVerify(token, SECRET),
      getViewerPortalConfig(),
    ]);
    return payload.portal === true
      && portal.enabled
      && Boolean(portal.passwordHash)
      && payload.authVersion === portal.authVersion;
  } catch {
    return false;
  }
}

export async function setViewerPortalCookie(cookieStore, request, authVersion) {
  cookieStore.set(VIEWER_PORTAL_COOKIE, await createViewerPortalToken(authVersion), {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/api/viewer-portal",
  });
}

export function clearViewerPortalCookie(cookieStore) {
  cookieStore.set(VIEWER_PORTAL_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/viewer-portal",
    expires: new Date(0),
  });
}
