import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { listTenants } from "@/lib/services/provisioning";

export const metadata: Metadata = { title: "Sekolah" };
export const dynamic = "force-dynamic";
const STATUSES = ["PROVISIONING", "ACTIVE", "SUSPENDED"];

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; trash?: string; page?: string }> }) {
  const sp = await searchParams; const { ctx } = await requireSuperAdmin();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const status = STATUSES.includes(sp.status ?? "") ? sp.status : undefined; const trash = sp.trash === "1";
  const { rows, total, pages } = await listTenants(actorOf(ctx), { q: sp.q?.slice(0, 80), status, trash, page });
  const qs = (p: number) => new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(status ? { status } : {}), ...(trash ? { trash: "1" } : {}), page: String(p) }).toString();
  return (
    <main>
      <div className="row"><div><h1>Sekolah</h1><p className="muted">{total} {trash ? "di tempat sampah" : "sekolah"}</p></div><a className="btn primary inline" href="/super/tenants/new">+ Sekolah baru</a></div>
      <form className="card filters" method="get">
        <div><label htmlFor="q">Cari nama/slug</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={80} /></div>
        <div><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={status ?? ""}><option value="">Semua</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div><label htmlFor="trash">Tampilkan</label><select id="trash" name="trash" defaultValue={trash ? "1" : ""}><option value="">Aktif</option><option value="1">Tempat sampah</option></select></div>
        <button className="btn inline" type="submit">Terapkan</button>
      </form>
      <div className="card scroll">
        <table><thead><tr><th>Nama</th><th>Slug</th><th>Jenis</th><th>Paket</th><th>Status</th><th>Langganan</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}><td><a href={`/super/tenants/${t.id}`}>{t.name}</a></td><td>{t.slug}</td><td>{t.type}</td><td>{t.subscription?.planVersion.plan.name ?? "—"}</td><td><span className={`badge ${t.status}`}>{t.status}</span></td><td>{t.subscription?.status ?? "—"}</td></tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={6} className="muted">Tidak ada data.</td></tr> : null}
          </tbody></table>
        {pages > 1 ? <div className="pager">{page > 1 ? <a href={`?${qs(page - 1)}`}>← Sebelumnya</a> : null}<span className="muted">Hal. {page}/{pages}</span>{page < pages ? <a href={`?${qs(page + 1)}`}>Berikutnya →</a> : null}</div> : null}
      </div>
    </main>
  );
}
