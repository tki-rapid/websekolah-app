import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listTenants, recentAudit } from "@/lib/dal/platform";

export const metadata: Metadata = { title: "Konsol Super Admin" };
export const dynamic = "force-dynamic";

export default async function SuperHome() {
  const { user, principal } = await requireSuperAdmin();
  const [tenants, audit] = await Promise.all([listTenants(principal), recentAudit(principal, 15)]);
  return (
    <main>
      <div className="row">
        <div><h1>Konsol Super Admin</h1><p className="muted">{tenants.length} sekolah · {user.email} · MFA terverifikasi</p></div>
        <a className="btn primary inline" href="/super/tenants/new">+ Sekolah baru</a>
      </div>
      <div className="card">
        <h2>Sekolah</h2>
        <table><thead><tr><th>Nama</th><th>Slug</th><th>Jenis</th><th>Status</th><th>Langganan</th></tr></thead>
          <tbody>{tenants.map((t) => (<tr key={t.id}><td><a href={`/super/tenants/${t.id}`}>{t.name}</a></td><td>{t.slug}</td><td>{t.type}</td><td><span className="badge">{t.status}</span></td><td>{t.subscription?.status ?? "—"}</td></tr>))}</tbody></table>
      </div>
      <div className="card">
        <h2>Audit terbaru</h2>
        <table><thead><tr><th>Waktu</th><th>Aktor</th><th>Tindakan</th><th>Resource</th><th>Hasil</th></tr></thead>
          <tbody>{audit.map((a) => (<tr key={a.id}><td>{a.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td><td>{a.actorEmail}</td><td><code>{a.action}</code></td><td>{a.resource}</td><td>{a.result}</td></tr>))}</tbody></table>
      </div>
    </main>
  );
}
