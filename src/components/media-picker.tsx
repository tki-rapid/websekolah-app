"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFile } from "./upload";

type Item = { id: string; name: string; mime: string; bytes: number; usedIn: number };
type Accept = "image" | "pdf" | undefined;

export const mediaUrl = (id: string, thumb = true) => `/api/media/${id}${thumb ? "?v=thumb" : ""}`;

/** Modal library: pick an existing file or upload a new one (same secure pipeline as the media page). */
export function MediaPickerDialog({ open, accept, onPick, onClose }: { open: boolean; accept: Accept; onPick: (m: { id: string; name: string; mime: string }) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState(""); const [step, setStep] = useState("");
  const load = useCallback(async () => {
    setErr("");
    const r = await fetch(`/api/media${accept ? `?kind=${accept}` : ""}`);
    if (!r.ok) { setErr("Gagal memuat pustaka media"); return; }
    setItems(((await r.json()) as { rows: Item[] }).rows);
  }, [accept]);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { d.showModal(); void load(); }
    if (!open && d.open) d.close();
  }, [open, load]);
  async function onFile(f: File | undefined) {
    if (!f) return; setErr("");
    try { const m = await uploadFile(f, setStep); setStep(""); onPick(m); } catch (e) { setStep(""); setErr(e instanceof Error ? e.message : "Unggahan gagal"); }
  }
  return (
    <dialog ref={ref} className="dlg" onClose={onClose} aria-label="Pustaka media">
      <div className="row"><h2>Pilih {accept === "pdf" ? "PDF" : accept === "image" ? "gambar" : "berkas"}</h2><button className="btn sm" type="button" onClick={onClose}>Tutup</button></div>
      <label className="btn sm up">{step || "Unggah baru"}<input type="file" hidden accept={accept === "pdf" ? "application/pdf" : accept === "image" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,application/pdf"} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
      {err ? <p className="err" role="alert">{err}</p> : null}
      <div className="mgrid">
        {items?.map((m) => (
          <button key={m.id} type="button" className="mitem" onClick={() => onPick(m)}>
            {m.mime.startsWith("image/") ? <img src={mediaUrl(m.id)} alt="" loading="lazy" /> : <span className="pdf">PDF</span>}
            <span className="mname">{m.name}</span>
          </button>
        ))}
        {items && items.length === 0 ? <p className="muted">Belum ada berkas. Unggah yang pertama.</p> : null}
        {!items && !err ? <p className="muted">Memuat…</p> : null}
      </div>
    </dialog>
  );
}
