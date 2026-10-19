import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { uuidParam } from "@/lib/security/request";
import { NotFoundError } from "@/lib/errors";
import { getTenantDetail } from "@/lib/services/provisioning";
import OpForm from "./op-form";

export const metadata: Metadata = { title: "Detail sekolah" };
export const dynamic = "force-dynamic";
const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }) + " WIB" : "—");

export default async function TenantDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const id = uuidParam((await params).id); if (!id) notFound();
  const { created } = await searchParams; const { ctx } = await requireSuperAdmin();
  const actor = actorOf(ctx);
  const d = await getTenantDetail(actor, id).catch((e) => { if (e instanceof NotFoundError) notFound(); throw e; });
  const t = d.tenant, deleted = !!t.deletedAt;
  return (
    <main className="stack">
      <div className="row">
        <div><h1>{t.name}</h1><p className="muted">{t.slug}.websekolah.id · {t.type} · <span className={`badge ${t.status}`}>{t.status}</span>{deleted ? <> · <span className="badge SUSPENDED">DIHAPUS {fmt(t.deletedAt)}</span></> : null}</p></div>
        <a className="btn inline sm" href="/super/tenants">← Daftar sekolah</a>
      </div>
      {created ? <p className="flash" role="status">Sekolah dibuat. Email undangan masuk antrean dan dikirim ke admin dalam hitungan menit.</p> : null}
      {!actor.reauthOk ? <p className="flash bad" role="status">Aksi sensitif memerlukan konfirmasi identitas (maks. 10 menit). <a href={`/reauth?next=/super/tenants/${id}`}>Konfirmasi sekarang</a></p> : null}
      <div className="grid">
        <div className="card"><h2>Langganan</h2><dl className="kv"><dt>Paket</dt><dd>{t.subscription?.planVersion.plan.name ?? "—"} ({t.subscription?.planVersion.interval ?? "—"})</dd><dt>Status</dt><dd>{t.subscription ? <span className={`badge ${t.subscription.status}`}>{t.subscription.status}</span> : "—"}</dd><dt>Dibuat</dt><dd>{fmt(t.createdAt)}</dd>{t.suspendReason ? <><dt>Alasan tangguh</dt><dd>{t.suspendReason}</dd></> : null}</dl></div>
        <div className="card"><h2>Admin sekolah</h2>{d.admin ? <dl className="kv"><dt>Nama</dt><dd>{d.admin.name}</dd><dt>Email</dt><dd>{d.admin.email}</dd><dt>Akun</dt><dd>{d.admin.activated ? <span className="badge ACTIVE">Aktif</span> : <span className="badge PENDING">Menunggu aktivasi</span>}</dd><dt>Login terakhir</dt><dd>{fmt(d.admin.lastLoginAt)}</dd><dt>Undangan</dt><dd>{d.invitation ? (d.invitation.usedAt ? "Dipakai" : `Berlaku s.d. ${fmt(d.invitation.expiresAt)}`) : "—"}</dd></dl> : <p className="muted">Belum ada admin aktif.</p>}</div>
        <div className="card"><h2>Domain</h2><ul>{t.domains.map((x) => <li key={x.id}><code>{x.hostname}</code> <span className="badge">{x.kind}</span> <span className="badge">{x.status}</span></li>)}</ul></div>
      </div>

      {deleted ? (
        <div className="card"><h2>Pulihkan</h2><OpForm tenantId={id} op="restore" label="Pulihkan sekolah" hint="Dapat dipulihkan sampai 30 hari setelah dihapus. Sekolah kembali dalam status ditangguhkan; domain kustom harus diverifikasi ulang." /></div>
      ) : (
        <div className="grid">
          {t.status !== "ACTIVE" ? <div className="card"><h2>Aktifkan</h2><OpForm tenantId={id} op="activate" label="Aktifkan sekolah" hint="Mengaktifkan sekolah dan langganannya." /></div> : null}
          {t.status === "ACTIVE" ? <div className="card"><h2>Tangguhkan</h2><OpForm tenantId={id} op="suspend" label="Tangguhkan" danger fields={[{ name: "reason", label: "Alasan (dicatat di audit)", textarea: true }]} hint="Situs publik tampil sebagai ditangguhkan; admin sekolah tidak dapat mengubah konten." /></div> : null}
          {d.admin && !d.admin.activated ? <div className="card"><h2>Kirim ulang undangan</h2><OpForm tenantId={id} op="resend" label="Kirim ulang" hint="Tautan lama otomatis dicabut." /></div> : null}
          <div className="card"><h2>Ganti admin</h2><OpForm tenantId={id} op="replace" label="Ganti admin" danger fields={[{ name: "name", label: "Nama admin baru" }, { name: "email", label: "Email admin baru", type: "email" }]} hint="Semua sesi admin lama langsung dicabut. Hanya satu admin aktif per sekolah." /></div>
          <div className="card"><h2>Hapus sekolah</h2><OpForm tenantId={id} op="delete" label="Hapus (soft delete)" danger fields={[{ name: "confirmSlug", label: `Ketik "${t.slug}" untuk konfirmasi` }]} hint="Situs offline dan sesi dicabut; dapat dipulihkan 30 hari." /></div>
        </div>
      )}

      <div className="card scroll"><h2>Audit sekolah ini</h2>
        <table><thead><tr><th>Waktu</th><th>Aktor</th><th>Tindakan</th><th>Resource</th><th>Hasil</th></tr></thead>
          <tbody>{d.audit.map((a) => <tr key={a.id}><td>{fmt(a.createdAt)}</td><td>{a.actorEmail}</td><td><code>{a.action}</code></td><td>{a.resource}</td><td>{a.result}{a.reason ? ` · ${a.reason}` : ""}</td></tr>)}</tbody></table>
      </div>
    </main>
  );
}
