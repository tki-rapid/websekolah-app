import { platformClient, type Tx } from "@/lib/db";
import { sealSecret, openSecret } from "@/lib/security/crypto";

/**
 * Durable job queue on PostgreSQL (PRD §11/§13): dedupe key, max 5 attempts with exponential backoff,
 * dead-letter state, FOR UPDATE SKIP LOCKED so several Cloud Run instances can poll safely.
 * Sensitive payload fields (e.g. a raw invitation token) travel ONLY inside `enc` (AES-GCM) and are wiped when the job completes.
 */
export const MAX_ATTEMPTS = 5;
const STALE_RUNNING_MS = 5 * 60_000;

export type JobInput = { type: string; tenantId?: string | null; payload?: Record<string, unknown>; secret?: Record<string, unknown>; dedupeKey: string; delaySec?: number };
type JobRow = { id: string; tenant_id: string | null; type: string; payload: Record<string, unknown>; attempts: number };
export type JobContext = { id: string; tenantId: string | null; payload: Record<string, unknown>; secret: Record<string, unknown>; attempts: number };
export type JobHandler = (job: JobContext) => Promise<void>;

/** Enqueue inside the caller's transaction so the job exists iff the business change committed (outbox pattern). Duplicates are ignored. */
export async function enqueue(client: Pick<Tx, "$executeRaw">, j: JobInput): Promise<void> {
  const payload = JSON.stringify({ ...(j.payload ?? {}), ...(j.secret ? { enc: sealSecret(JSON.stringify(j.secret)) } : {}) });
  const at = new Date(Date.now() + (j.delaySec ?? 0) * 1000);
  // Raw INSERT … ON CONFLICT DO NOTHING: the tenant DB role may INSERT jobs but (deliberately) not SELECT them,
  // so an ORM `create` (INSERT … RETURNING) would be refused. Duplicate dedupe keys are ignored.
  await client.$executeRaw`INSERT INTO jobs (type, tenant_id, payload, dedupe_key, available_at)
    VALUES (${j.type}, ${j.tenantId ?? null}::uuid, ${payload}::jsonb, ${j.dedupeKey}, ${at}) ON CONFLICT DO NOTHING`;
}

const handlers = new Map<string, JobHandler>();
export const registerHandler = (type: string, h: JobHandler) => void handlers.set(type, h);

export async function runDueJobs(limit = 10): Promise<{ done: number; retried: number; dead: number }> {
  const db = platformClient();
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE jobs SET state = 'RUNNING', locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs
        WHERE (state IN ('QUEUED','RETRY') AND available_at <= now())
           OR (state = 'RUNNING' AND locked_at < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000}))
        ORDER BY available_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, tenant_id, type, payload, attempts`;
  const out = { done: 0, retried: 0, dead: 0 };
  for (const r of rows) {
    try {
      const h = handlers.get(r.type);
      if (!h) throw new Error(`no handler for ${r.type}`);
      const { enc, ...payload } = r.payload as { enc?: string };
      await h({ id: r.id, tenantId: r.tenant_id, payload, secret: enc ? JSON.parse(openSecret(enc)) : {}, attempts: r.attempts });
      await db.job.update({ where: { id: r.id }, data: { state: "DONE", lockedAt: null, lastError: null, payload: {} } }); // wipe sealed secrets
      out.done++;
    } catch (e) {
      const dead = r.attempts >= MAX_ATTEMPTS;
      const backoffSec = Math.min(3600, 30 * 2 ** (r.attempts - 1));
      await db.job.update({ where: { id: r.id }, data: { state: dead ? "DEAD" : "RETRY", lockedAt: null, lastError: String(e).slice(0, 500), availableAt: new Date(Date.now() + backoffSec * 1000) } });
      if (dead) { out.dead++; console.error(JSON.stringify({ level: "error", msg: "job dead-lettered", type: r.type, id: r.id })); } else out.retried++;
    }
  }
  return out;
}
