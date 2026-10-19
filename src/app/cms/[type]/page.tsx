import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { getSingleton, listContent, type ContentStatus } from "@/lib/services/content";
import { getSettings } from "@/lib/services/settings";
import { MODULE_ORDER, SINGLETON_ORDER, typeDef } from "@/lib/content/types";
import { clientDef } from "@/lib/content/client-defs";
import ContentEditor from "./editor";
import ReorderButtons from "./reorder";

export const dynamic = "force-dynamic";
const STATUS: ContentStatus[] = ["draft", "published", "changed"];
const LABEL: Record<string, string> = { draft: "Draft", published: "Terbit", changed: "Terbit + draft baru" };
const isListed = (t: string) => (MODULE_ORDER as readonly string[]).includes(t);
const isSingleton = (t: string) => (SINGLETON_ORDER as readonly string[]).includes(t);

export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const d = typeDef((await params).type); return { title: d?.label ?? "Konten" };
}

export default async function ModulePage({ params, searchParams }: { params: Promise<{ type: string }>; searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const { type } = await params; const sp = await searchParams;
  if (!isListed(type) && !isSingleton(type)) notFound();
  const { ctx } = await requireSchoolAdmin(); const actor = actorOf(ctx);
  const d = typeDef(type)!;

  if (isSingleton(type)) {
    const [cur, s] = await Promise.all([getSingleton(actor, type), getSettings(actor)]);
    const def = clientDef(type)!;
    return (
      <main>
        <h1>{d.label}</h1>
        <ContentEditor def={def} enableEn={s.enableEn} defaultLang={s.defaultLang as "id" | "en"} initial={{ id: cur?.id ?? null, version: cur?.version ?? 0, slug: cur?.slug ?? "", status: cur?.status ?? "draft", draft: cur?.draft ?? {} }} />
      </main>
    );
  }

  const status = STATUS.find((x) => x === sp.status);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pages } = await listContent(actor, type, { q: sp.q?.slice(0, 80), status, page });
  const qs = (p: number) => new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(status ? { status } : {}), page: String(p) }).toString();
  return (
    <main>
      <div className="row"><div><h1>{d.label}</h1><p className="muted">{total} item</p></div><a className="btn primary inline" href={`/cms/${type}/new`}>+ {d.label} baru</a></div>
      <form className="card filters" method="get">
        <div><label htmlFor="q">Cari judul</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={80} /></div>
        <div><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={status ?? ""}><option value="">Semua</option>{STATUS.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select></div>
        <button className="btn inline" type="submit">Terapkan</button>
      </form>
      <div className="card scroll">
        <table>
          <thead><tr><th>Judul</th><th>Status</th><th>EN</th><th>Diubah</th>{d.ordered ? <th>Urutan</th> : null}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td><a href={`/cms/${type}/${r.id}`}>{r.title || "(tanpa judul)"}</a></td>
                <td><span className={`badge ${r.status}`}>{LABEL[r.status]}</span></td>
                <td>{r.en === "complete" ? "✓" : r.en === "partial" ? "sebagian" : "—"}</td>
                <td>{r.updatedAt.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium" })}</td>
                {d.ordered ? <td><ReorderButtons type={type} ids={rows.map((x) => x.id)} index={i} /></td> : null}
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={d.ordered ? 5 : 4} className="muted">Belum ada data.</td></tr> : null}
          </tbody>
        </table>
        {pages > 1 ? <div className="pager">{page > 1 ? <a href={`?${qs(page - 1)}`}>← Sebelumnya</a> : null}<span className="muted">Hal. {page}/{pages}</span>{page < pages ? <a href={`?${qs(page + 1)}`}>Berikutnya →</a> : null}</div> : null}
      </div>
    </main>
  );
}
