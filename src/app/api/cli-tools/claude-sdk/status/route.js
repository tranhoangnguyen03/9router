import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const exec = promisify(execFile);

// Auth status is checked by Claude Code itself; 9Router never reads credentials.
async function check(binary, args) {
  try {
    return await exec(binary, args, { timeout: 6000, windowsHide: true, maxBuffer: 32768 });
  } catch {
    return null;
  }
}
export async function GET() {
  const binary = process.env.CLAUDE_CODE_EXECUTABLE || "claude";
  const version = await check(binary, ["--version"]);
  if (!version) {
    return NextResponse.json({ ready: false, reason: "Claude Code is missing or cannot run. Install the CLI and ensure it is in PATH." });
  }
  const status = await check(binary, ["auth", "status", "--json"]);
  let signedIn = false;
  if (status) {
    try {
      const parsed = JSON.parse(status.stdout || "{}");
      signedIn = parsed.loggedIn === true || parsed.authenticated === true;
    } catch {
      signedIn = false;
    }
  }
  return NextResponse.json({
    ready: signedIn,
    version: version.stdout.trim().slice(0, 120),
    ...(!signedIn ? { reason: "Not signed in, or this Claude Code version does not support auth status --json. Run claude auth login." } : {})
  });
}
