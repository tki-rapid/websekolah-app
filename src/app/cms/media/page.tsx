import type { Metadata } from "next";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { listMedia } from "@/lib/services/media";
import MediaLibrary from "./library";

export const metadata: Metadata = { title: "Pustaka media" };
export const dynamic = "force-dynamic";

export default async function MediaPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; page?: string }> }) {
  const sp = await searchParams; const { ctx } = await requireSchoolAdmin();
  const kind = sp.kind === "image" || sp.kind === "pdf" ? sp.kind : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const r = await listMedia(actorOf(ctx), { kind, q: sp.q?.slice(0, 80), page });
  const qs = (p: number) => new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(kind ? { kind } : {}), page: String(p) }).toString();
  const mb = (n: number) => (n / 1048576).toFixed(1);
  return (
    <main className="stack">
      <div><h1>Pustaka media</h1><p className="muted">Gambar (JPG/PNG/WebP, maks. 5 MB) dan PDF (maks. 20 MB). Metadata EXIF/GPS dihapus otomatis.</p></div>
      <div className="card">
        <label htmlFor="quota">Penyimpanan: {mb(r.usage.used)} MB dari {mb(r.usage.quota)} MB</label>
        <meter id="quota" min={0} max={Math.max(r.usage.quota, 1)} low={r.usage.quota * 0.7} high={r.usage.quota * 0.9} optimum={0} value={Math.min(r.usage.used, r.usage.quota)} />
      </div>
      <form className="card filters" method="get">
        <div><label htmlFor="q">Cari nama</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={80} /></div>
        <div><label htmlFor="kind">Jenis</label><select id="kind" name="kind" defaultValue={kind ?? ""}><option value="">Semua</option><option value="image">Gambar</option><option value="pdf">PDF</option></select></div>
        <button className="btn inline" type="submit">Terapkan</button>
      </form>
      <MediaLibrary rows={r.rows.map((m) => ({ id: m.id, name: m.name, mime: m.mime, bytes: m.bytes, alt: m.alt, usedIn: m.usedIn }))} />
      {r.pages > 1 ? <div className="pager">{page > 1 ? <a href={`?${qs(page - 1)}`}>← Sebelumnya</a> : null}<span className="muted">Hal. {page}/{r.pages}</span>{page < r.pages ? <a href={`?${qs(page + 1)}`}>Berikutnya →</a> : null}</div> : null}
    </main>
  );
}
