import type { NextRequest } from "next/server";
import { json } from "@/lib/http";
import { getStore, LocalObjectStore } from "@/lib/media/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Dev/test upload endpoint (MEDIA_BACKEND=local): the stand-in for a GCS V4 signed URL. It accepts a PUT only with a valid
 * HMAC signature over key|expiry|content-type|max-bytes, enforces the byte cap while streaming, and nothing else.
 * In production (GCS) this route does not exist: it answers 404.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string[] }> }) {
  const store = getStore();
  if (!(store instanceof LocalObjectStore)) return json({ error: "not_found" }, 404);
  const key = (await ctx.params).key.map((s) => decodeURIComponent(s)).join("/");
  const q = req.nextUrl.searchParams;
  const exp = Number(q.get("exp")), max = Number(q.get("max")), ct = q.get("ct") ?? "", sig = q.get("sig") ?? "";
  if (!Number.isInteger(max) || max <= 0 || !store.verify(key, exp, ct, max, sig)) return json({ error: "forbidden" }, 403);
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== ct) return json({ error: "content_type" }, 415);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return json({ error: "too_large" }, 413);
  const chunks: Buffer[] = []; let total = 0;
  const reader = req.body?.getReader();
  if (!reader) return json({ error: "empty" }, 400);
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return json({ error: "too_large" }, 413); }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) return json({ error: "empty" }, 400);
  await store.write(key, Buffer.concat(chunks), ct);
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
