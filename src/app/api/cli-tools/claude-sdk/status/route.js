import { NextResponse } from "next/server";
import { checkSdkStatus } from "open-sse/executors/claude-sdk-runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await checkSdkStatus());
}
