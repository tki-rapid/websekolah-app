import { NextResponse } from "next/server";
import { platformClient, tenantClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness/readiness for Cloud Run. Reports only up/down — no versions, hostnames or error details. */
export async function GET() {
  try {
    await Promise.all([tenantClient().$queryRaw`SELECT 1`, platformClient().$queryRaw`SELECT 1`]);
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
