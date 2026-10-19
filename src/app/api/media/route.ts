import type { NextRequest } from "next/server";
import { json, withSchoolActor } from "@/lib/http";
import { listMedia } from "@/lib/services/media";

export const dynamic = "force-dynamic";

export const GET = (req: NextRequest) => withSchoolActor(req, async (actor) => {
  const q = req.nextUrl.searchParams; const kind = q.get("kind");
  const r = await listMedia(actor, { kind: kind === "image" || kind === "pdf" ? kind : undefined, q: q.get("q")?.slice(0, 80) || undefined, page: Math.max(1, Number.parseInt(q.get("page") ?? "1", 10) || 1) });
  return json(r);
});
