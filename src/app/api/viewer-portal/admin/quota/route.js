import { NextResponse } from "next/server";
import { getQuotaAccounts } from "@/lib/viewerPortal/quota";
import { toAdminPortalConfig, updateViewerPortalConfig, validateAndNormalizeQuotaAccounts } from "@/lib/viewerPortal/config";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Dashboard authentication is enforced by the existing deny-by-default guard.
export async function GET() {
  try {
    return NextResponse.json({ accounts: await getQuotaAccounts() }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not load quota accounts" }, { status: 500, headers });
  }
}

export async function PUT(request) {
  let quotaAccounts;
  try {
    const [body, accounts] = await Promise.all([request.json(), getQuotaAccounts()]);
    quotaAccounts = validateAndNormalizeQuotaAccounts(body?.quotaAccounts, new Set(accounts.map(({ id }) => id)));
  } catch {
    return NextResponse.json({ error: "Select up to 100 unique, supported accounts with public labels of at most 80 characters" }, { status: 400, headers });
  }
  try {
    const portal = await updateViewerPortalConfig(current => ({ ...current, quotaAccounts }));
    return NextResponse.json({ portal: toAdminPortalConfig(portal) }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not save quota accounts" }, { status: 500, headers });
  }
}
