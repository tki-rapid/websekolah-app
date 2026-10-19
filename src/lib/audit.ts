import { platformClient, type Tx } from "@/lib/db";

export type AuditEntry = {
  tenantId?: string | null;
  actorId?: string | null;
  actorEmail: string;
  effectiveUserId?: string | null;
  action: string; // e.g. "auth.login", "tenant.suspend"
  resource: string;
  result?: "success" | "denied" | "failure";
  reason?: string | null;
  ip?: string | null;
  requestId?: string | null;
};

/** Append-only (DB trigger enforces it). Never put passwords, tokens or full payloads in `resource`/`reason`. */
export async function writeAudit(client: Pick<Tx, "auditLog">, e: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      tenantId: e.tenantId ?? null,
      actorId: e.actorId ?? null,
      actorEmail: e.actorEmail.slice(0, 254),
      effectiveUserId: e.effectiveUserId ?? null,
      action: e.action.slice(0, 80),
      resource: e.resource.slice(0, 200),
      result: e.result ?? "success",
      reason: e.reason?.slice(0, 300) ?? null,
      ip: e.ip ?? null,
      requestId: e.requestId ?? null,
    },
  });
}

/** Platform-level audit (auth events, operator actions). Failures to audit must not break the request path silently. */
export async function audit(e: AuditEntry): Promise<void> {
  try {
    await writeAudit(platformClient(), e);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "audit write failed", action: e.action, err: String(err) }));
    throw err;
  }
}
