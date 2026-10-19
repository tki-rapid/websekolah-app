import { NextResponse } from "next/server";
import { platformClient, tenantClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness/readiness for Cloud Run. Reports only up/down — no versions, hostnames or error details. */
export async function GET() {
  try {
    await Promise.all([tenantClient().$queryRaw`SELECT 1`, platformClient().$queryRaw`SELECT 1`]);
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Keep the public response opaque, but record safe diagnostics for deployment health checks.
    console.error("Database health check failed", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
