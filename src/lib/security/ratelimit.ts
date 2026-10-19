import { platformClient } from "@/lib/db";

export type RateResult = { allowed: boolean; remaining: number; retryAfterSec: number };

/**
 * Fixed-window counter in PostgreSQL, so limits hold across all Cloud Run instances.
 * One atomic upsert per attempt (no read-modify-write race).
 */
export async function consume(key: string, limit: number, windowSec: number): Promise<RateResult> {
  const rows = await platformClient().$queryRaw<{ count: number; reset_in: number }[]>`
    INSERT INTO rate_limits (key, count, window_start) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}) THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}) THEN now() ELSE rate_limits.window_start END
    RETURNING count, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSec}) - now()))))::int AS reset_in`;
  const r = rows[0]!;
  return { allowed: r.count <= limit, remaining: Math.max(0, limit - r.count), retryAfterSec: r.reset_in };
}

export async function resetLimit(key: string): Promise<void> {
  await platformClient().rateLimit.deleteMany({ where: { key } });
}

/** Housekeeping for the worker: drop counters whose window ended long ago. */
export async function purgeExpired(olderThanSec = 86_400): Promise<number> {
  const r = await platformClient().$executeRaw`DELETE FROM rate_limits WHERE window_start < now() - make_interval(secs => ${olderThanSec})`;
  return Number(r);
}
