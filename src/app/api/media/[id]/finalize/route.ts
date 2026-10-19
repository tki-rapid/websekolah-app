import type { NextRequest } from "next/server";
import { json, withSchoolActor } from "@/lib/http";
import { finalizeUpload } from "@/lib/services/media";
import { uuidParam } from "@/lib/security/request";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => withSchoolActor(req, async (actor) => {
  const id = uuidParam((await ctx.params).id);
  if (!id) return json({ error: "not_found", message: "Media tidak ditemukan" }, 404);
  const a = await finalizeUpload(actor, id);
  return json({ id: a.id, name: a.name, mime: a.mime, bytes: Number(a.bytes), width: a.width, height: a.height });
});
