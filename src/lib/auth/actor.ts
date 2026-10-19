import "server-only";
import type { Actor } from "@/lib/actor";
import { hasRecentReauth, type SessionContext } from "@/lib/auth/session";
import { principalOf } from "@/lib/auth/guards";

/** Build the acting identity for services from the authenticated session — never from request input. */
export function actorOf(ctx: SessionContext, ip?: string): Actor {
  return { principal: principalOf(ctx), userId: ctx.user.id, email: ctx.user.email, tenantId: ctx.user.tenantId, ip, reauthOk: hasRecentReauth(ctx.session) };
}
