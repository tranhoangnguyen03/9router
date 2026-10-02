import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";

// Shutdown app to release file locks for manual update
export async function POST() {
  if (process.env.NINEROUTER_MANAGED_DEPLOYMENT === "true") {
    return NextResponse.json(
      { success: false, managedDeployment: true, message: "Shutdown is managed by the host deployment tooling." },
      { status: 403 }
    );
  }

  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
