import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { getSession, requestMeta } from "@/lib/auth/cookies";
import { isFullyAuthenticated } from "@/lib/auth/session";
import { actorOf } from "@/lib/auth/actor";
import { assertSameOrigin, OriginError } from "@/lib/security/request";
import { ForbiddenError } from "@/lib/auth/rbac";
import { AppError, ConflictError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/actor";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Map typed failures to HTTP; anything unexpected becomes an opaque 500 (details stay in the server log). */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof OriginError) return json({ error: "origin", message: "Permintaan ditolak" }, 403);
  if (e instanceof ForbiddenError) return json({ error: "forbidden", message: "Tidak diizinkan" }, 403);
  if (e instanceof ValidationError) return json({ error: "validation", message: e.message, fields: e.fields }, 422);
  if (e instanceof ConflictError) return json({ error: "conflict", message: e.message, currentVersion: e.currentVersion }, 409);
  if (e instanceof AppError) return json({ error: e.code, message: e.message }, e.status);
  console.error("[api] unexpected error", e instanceof Error ? e.message : e);
  return json({ error: "internal", message: "Terjadi kesalahan" }, 500);
}

/** Authenticated API call for the school CMS: session cookie → actor, Origin check on unsafe methods. */
export async function withSchoolActor(req: NextRequest, fn: (actor: Actor) => Promise<NextResponse | Response>): Promise<NextResponse | Response> {
  try {
    const meta = await requestMeta();
    if (!["GET", "HEAD"].includes(req.method)) assertSameOrigin(req.headers, env().APP_URL);
    const ctx = await getSession();
    if (!ctx || !isFullyAuthenticated(ctx)) return json({ error: "unauthenticated", message: "Silakan masuk" }, 401);
    if (ctx.user.role !== "SCHOOL_ADMIN") return json({ error: "forbidden", message: "Tidak diizinkan" }, 403);
    return await fn(actorOf(ctx, meta.ip));
  } catch (e) { return errorResponse(e); }
}
