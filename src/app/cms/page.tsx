import type { Metadata } from "next";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { getTenantOverview } from "@/lib/dal/tenant";
import { MODULE_ORDER, SINGLETON_ORDER, TYPES } from "@/lib/content/types";

export const metadata: Metadata = { title: "CMS Sekolah" };
export const dynamic = "force-dynamic";

export default async function CmsHome() {
  const { tenantId } = await requireSchoolAdmin();
  const o = await getTenantOverview(tenantId); // runs under Row Level Security for THIS school only
  return (
    <main className="stack">
      <div><h1>{o.tenant.name}</h1><p className="muted">{o.tenant.slug}.websekolah.id · {o.tenant.type} · <span className={`badge ${o.tenant.status}`}>{o.tenant.status}</span></p></div>
      {o.tenant.status === "SUSPENDED" ? <p className="flash bad" role="alert">Layanan ditangguhkan. Konten tidak dapat diubah. Hubungi operator.</p> : null}
      {o.tenant.status === "PROVISIONING" ? <p className="flash" role="status">Sekolah Anda sedang disiapkan. Anda sudah dapat menyiapkan konten sebagai draft.</p> : null}
      <div className="grid">
        <div className="card stat"><b>{o.counts.published}</b><span className="muted">Konten terbit</span></div>
        <div className="card stat"><b>{o.counts.drafts}</b><span className="muted">Draft</span></div>
        <div className="card stat"><b>{o.counts.pages}</b><span className="muted">Halaman</span></div>
        <div className="card stat"><b>{o.counts.media}</b><span className="muted">Media</span></div>
      </div>
      <div className="card">
        <h2>Kelola konten</h2>
        <div className="actions">
          {[...MODULE_ORDER, ...SINGLETON_ORDER].map((t) => <a key={t} className="btn sm" href={`/cms/${t}`}>{TYPES[t]!.label}</a>)}
        </div>
      </div>
      <p className="muted">Langganan: {o.subscription?.status ?? "—"} · Bahasa: {o.tenant.enableEn ? `ID + EN (awal: ${o.tenant.defaultLang.toUpperCase()})` : "ID"} · Google Analytics: {o.tenant.gaEnabled ? "aktif" : "nonaktif"} · <a href="/cms/settings">Ubah pengaturan</a></p>
    </main>
  );
}
