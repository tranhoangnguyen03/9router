import { getClientIp } from "@/lib/auth/loginLimiter";

const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
const RESET_MS = 60 * 60 * 1000;
if (!globalThis._forkViewerPortalLoginAttempts) globalThis._forkViewerPortalLoginAttempts = new Map();
const attempts = globalThis._forkViewerPortalLoginAttempts;

export function getPortalLoginBucket(request) {
  return getClientIp(request);
}

export function checkPortalLoginLock(bucket) {
  const entry = attempts.get(bucket);
  if (!entry) return { locked: false };
  if (Date.now() - entry.lastAttempt > RESET_MS) {
    attempts.delete(bucket);
    return { locked: false };
  }
  if (entry.lockUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((entry.lockUntil - Date.now()) / 1000) };
  }
  if (entry.lockUntil) attempts.delete(bucket);
  return { locked: false };
}

export function recordPortalLoginFailure(bucket) {
  const entry = attempts.get(bucket) || { failures: 0, lockUntil: 0, lastAttempt: 0 };
  entry.failures += 1;
  entry.lastAttempt = Date.now();
  if (entry.failures >= MAX_FAILURES) {
    entry.failures = 0;
    entry.lockUntil = Date.now() + LOCK_MS;
  }
  attempts.set(bucket, entry);
  return checkPortalLoginLock(bucket);
}

export function clearPortalLoginFailures(bucket) {
  attempts.delete(bucket);
}
