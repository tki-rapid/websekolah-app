import type { NextRequest } from "next/server";
import { json, withSchoolActor } from "@/lib/http";
import { presignUpload } from "@/lib/services/media";

export const dynamic = "force-dynamic";

export const POST = (req: NextRequest) => withSchoolActor(req, async (actor) => {
  let body: { name?: unknown; mime?: unknown; bytes?: unknown };
  try { body = await req.json(); } catch { return json({ error: "validation", message: "Body harus JSON" }, 400); }
  const { assetId, ticket } = await presignUpload(actor, { name: body.name, mime: body.mime, bytes: body.bytes });
  return json({ assetId, upload: { url: ticket.url, method: ticket.method, headers: ticket.headers, expiresAt: ticket.expiresAt } }, 201);
});
