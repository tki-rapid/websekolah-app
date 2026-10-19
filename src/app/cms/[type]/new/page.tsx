import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { getSettings } from "@/lib/services/settings";
import { MODULE_ORDER, typeDef } from "@/lib/content/types";
import { clientDef } from "@/lib/content/client-defs";
import ContentEditor from "../editor";

export const metadata: Metadata = { title: "Konten baru" };
export const dynamic = "force-dynamic";

export default async function NewContentPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!(MODULE_ORDER as readonly string[]).includes(type)) notFound();
  const { ctx } = await requireSchoolAdmin(); const s = await getSettings(actorOf(ctx));
  const d = typeDef(type)!;
  return (
    <main>
      <p><a href={`/cms/${type}`}>← {d.label}</a></p>
      <h1>{d.label} baru</h1>
      <ContentEditor def={clientDef(type)!} enableEn={s.enableEn} defaultLang={s.defaultLang as "id" | "en"} initial={{ id: null, version: 0, slug: "", status: "draft", draft: {} }} />
    </main>
  );
}
