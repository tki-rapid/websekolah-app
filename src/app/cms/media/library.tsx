"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { uploadFile } from "@/components/upload";
import { mediaUrl } from "@/components/media-picker";

type Row = { id: string; name: string; mime: string; bytes: number; alt: string; usedIn: number };

export default function MediaLibrary({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [step, setStep] = useState(""); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  async function onFiles(files: FileList | null) {
    if (!files?.length) return; setErr(""); setOk("");
    for (const f of Array.from(files)) {
      try { await uploadFile(f, setStep); setOk(`${f.name} berhasil diunggah.`); } catch (e) { setErr(`${f.name}: ${e instanceof Error ? e.message : "gagal"}`); }
    }
    setStep(""); router.refresh();
  }
  async function del(m: Row) {
    if (!window.confirm(`Hapus "${m.name}"?`)) return; setErr(""); setOk("");
    const r = await fetch(`/api/media/${m.id}`, { method: "DELETE" });
    if (r.ok) { setOk("Dihapus."); router.refresh(); } else setErr(((await r.json().catch(() => ({}))) as { message?: string }).message ?? "Gagal menghapus");
  }
  async function alt(m: Row, v: string) {
    if (v === m.alt) return;
    const r = await fetch(`/api/media/${m.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alt: v }) });
    setErr(r.ok ? "" : "Gagal menyimpan teks alternatif"); if (r.ok) setOk("Teks alternatif tersimpan.");
  }
  return (
    <div className="stack">
      <div className="card">
        <label className="btn primary inline up">{step || "Unggah berkas"}<input type="file" multiple hidden disabled={!!step} accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} /></label>
        {err ? <p className="err" role="alert">{err}</p> : null}
        {ok ? <p className="ok" role="status">{ok}</p> : null}
      </div>
      <div className="mgrid">
        {rows.map((m) => (
          <div className="mcard" key={m.id}>
            {m.mime.startsWith("image/") ? <img src={mediaUrl(m.id)} alt={m.alt} loading="lazy" /> : <span className="pdf">PDF</span>}
            <div className="body">
              <b className="mname">{m.name}</b>
              <span className="muted">{(m.bytes / 1024).toFixed(0)} KB · dipakai {m.usedIn}×</span>
              {m.mime.startsWith("image/") ? <><label htmlFor={`alt-${m.id}`}>Teks alternatif</label><input id={`alt-${m.id}`} defaultValue={m.alt} maxLength={140} onBlur={(e) => void alt(m, e.target.value)} /></> : null}
              <p><button className="btn sm danger" type="button" disabled={m.usedIn > 0} title={m.usedIn > 0 ? "Masih dipakai konten" : undefined} onClick={() => void del(m)}>Hapus</button></p>
            </div>
          </div>
        ))}
        {rows.length === 0 ? <p className="muted">Belum ada berkas.</p> : null}
      </div>
    </div>
  );
}
