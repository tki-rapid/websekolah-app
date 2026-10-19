import type { NextRequest } from "next/server";
import { json, withSchoolActor } from "@/lib/http";
import { deleteMedia, readMedia, updateAlt } from "@/lib/services/media";
import { uuidParam } from "@/lib/security/request";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const notFound = () => json({ error: "not_found", message: "Media tidak ditemukan" }, 404);

/** CMS preview. Bytes are served only after the session + RLS check, with hardening headers; never from a public bucket. */
export const GET = (req: NextRequest, ctx: Ctx) => withSchoolActor(req, async (actor) => {
  const id = uuidParam((await ctx.params).id); if (!id) return notFound();
  const m = await readMedia(actor, id, req.nextUrl.searchParams.get("v") === "thumb" ? "thumb" : "orig");
  return new Response(new Uint8Array(m.data), { headers: {
    "Content-Type": m.mime, "Content-Length": String(m.data.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox", "Content-Disposition": `inline; filename="${encodeURIComponent(m.name)}"`, "Cross-Origin-Resource-Policy": "same-origin",
  } });
});

export const PATCH = (req: NextRequest, ctx: Ctx) => withSchoolActor(req, async (actor) => {
  const id = uuidParam((await ctx.params).id); if (!id) return notFound();
  const body = (await req.json().catch(() => ({}))) as { alt?: unknown };
  await updateAlt(actor, id, typeof body.alt === "string" ? body.alt : "");
  return json({ ok: true });
});

export const DELETE = (req: NextRequest, ctx: Ctx) => withSchoolActor(req, async (actor) => {
  const id = uuidParam((await ctx.params).id); if (!id) return notFound();
  await deleteMedia(actor, id);
  return json({ ok: true });
});
