import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { getContent } from "@/lib/services/content";
import { getSettings } from "@/lib/services/settings";
import { MODULE_ORDER, typeDef } from "@/lib/content/types";
import { clientDef } from "@/lib/content/client-defs";
import { uuidParam } from "@/lib/security/request";
import { NotFoundError } from "@/lib/errors";
import ContentEditor from "../editor";

export const metadata: Metadata = { title: "Ubah konten" };
export const dynamic = "force-dynamic";

export default async function EditContentPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id: rawId } = await params; const id = uuidParam(rawId);
  if (!id || !(MODULE_ORDER as readonly string[]).includes(type)) notFound();
  const { ctx } = await requireSchoolAdmin(); const actor = actorOf(ctx);
  const [c, s] = await Promise.all([getContent(actor, id).catch((e) => { if (e instanceof NotFoundError) notFound(); throw e; }), getSettings(actor)]);
  if (c.type !== type) notFound();
  const d = typeDef(type)!;
  return (
    <main>
      <p><a href={`/cms/${type}`}>← {d.label}</a></p>
      <h1>{c.title || d.label}</h1>
      <ContentEditor def={clientDef(type)!} enableEn={s.enableEn} defaultLang={s.defaultLang as "id" | "en"} initial={{ id: c.id, version: c.version, slug: c.slug, status: c.status, draft: c.draft }} />
    </main>
  );
}
