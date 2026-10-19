import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { json } from "@/lib/http";
import { safeEqual } from "@/lib/security/tokens";
import { bootJobs } from "@/lib/jobs-boot";
import { runDueJobs } from "@/lib/jobs";
import { cleanupExpiredUploads } from "@/lib/services/media";
import { purgeExpired } from "@/lib/security/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Worker tick, called by Cloud Scheduler every minute (OIDC-protected at the Cloud Run layer AND a bearer secret here).
 * Disabled (404) when JOB_RUNNER_TOKEN is not configured, so it can never be an open endpoint.
 */
export async function POST(req: NextRequest) {
  const token = env().JOB_RUNNER_TOKEN;
  if (!token) return json({ error: "not_found" }, 404);
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, token)) return json({ error: "unauthorized" }, 401);
  bootJobs();
  const jobs = await runDueJobs(50);
  const uploads = await cleanupExpiredUploads();
  const limits = await purgeExpired();
  return json({ jobs, expiredUploads: uploads, purgedRateLimits: limits });
}
