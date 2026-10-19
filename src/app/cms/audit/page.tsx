import type { Metadata } from "next";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { listSchoolAudit } from "@/lib/services/settings";

export const metadata: Metadata = { title: "Aktivitas" };
export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { ctx } = await requireSchoolAdmin(); const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const r = await listSchoolAudit(actorOf(ctx), page);
  return (
    <main className="stack">
      <div><h1>Aktivitas</h1><p className="muted">Catatan perubahan di sekolah Anda ({r.total}). Tidak dapat diubah atau dihapus.</p></div>
      <div className="card scroll">
        <table><thead><tr><th>Waktu</th><th>Pengguna</th><th>Tindakan</th><th>Objek</th><th>Hasil</th></tr></thead>
          <tbody>{r.rows.map((a) => <tr key={a.id}><td>{a.createdAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" })}</td><td>{a.actorEmail}</td><td><code>{a.action}</code></td><td>{a.resource}</td><td>{a.result}</td></tr>)}</tbody></table>
        {r.pages > 1 ? <div className="pager">{r.page > 1 ? <a href={`?page=${r.page - 1}`}>← Sebelumnya</a> : null}<span className="muted">Hal. {r.page}/{r.pages}</span>{r.page < r.pages ? <a href={`?page=${r.page + 1}`}>Berikutnya →</a> : null}</div> : null}
      </div>
    </main>
  );
}
