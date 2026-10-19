"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientDef } from "@/lib/content/client-defs";
import type { FieldDef } from "@/lib/content/types";
import { deleteContentAction, publicationAction, saveContentAction } from "../actions";
import { MediaPickerDialog, mediaUrl } from "@/components/media-picker";

type Obj = Record<string, unknown>;
type Lang = "id" | "en";
type Initial = { id: string | null; version: number; slug: string; status: string; draft: Obj };

const toLocalInput = (iso: unknown) => { if (typeof iso !== "string" || !iso) return ""; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ""; d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v: string) => { if (!v) return ""; const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };
const blankRow = (f: FieldDef): Obj => Object.fromEntries((f.sub ?? []).map((s) => [s.name, s.kind === "checkbox" ? false : ""]));

export default function ContentEditor({ def, initial, enableEn, defaultLang }: { def: ClientDef; initial: Initial; enableEn: boolean; defaultLang: Lang }) {
  const router = useRouter();
  const { _en: en0, ...rest } = initial.draft;
  const [values, setValues] = useState<Obj>(() => ({ ...def.defaults, ...rest }));
  const [en, setEn] = useState<Obj>(() => ((en0 as Obj) ?? {}));
  const [slug, setSlug] = useState(initial.slug);
  const [meta, setMeta] = useState({ id: initial.id, version: initial.version, status: initial.status });
  const [lang, setLang] = useState<Lang>("id");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState<{ accept: FieldDef["accept"]; apply: (m: { id: string; name: string }) => void } | null>(null);
  const hasTr = useMemo(() => def.fields.some((f) => f.tr || f.sub?.some((s) => s.tr)), [def]);
  const showTabs = enableEn && hasTr;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const touch = () => { setDirty(true); setMsg(null); };
  const setV = (name: string, v: unknown) => { setValues((p) => ({ ...p, [name]: v })); touch(); };
  const setE = (name: string, v: unknown) => { setEn((p) => ({ ...p, [name]: v })); touch(); };

  async function run(fn: () => ReturnType<typeof saveContentAction>, after?: (id: string) => void) {
    setBusy(true); setErrors({}); setMsg(null); setConflict(false);
    const r = await fn(); setBusy(false);
    if (r.ok) {
      setMeta({ id: r.id || meta.id, version: r.version, status: r.status }); if (r.slug) setSlug(r.slug); setDirty(false); setMsg({ kind: "ok", text: r.message }); after?.(r.id);
    } else {
      if (r.conflict) setConflict(true);
      setErrors(r.fields ?? {}); setMsg({ kind: "bad", text: r.error });
    }
  }
  const payload = () => ({ ...values, ...(Object.keys(en).length ? { _en: en } : {}) });
  const save = (mode: "draft" | "publish") => run(() => saveContentAction({ type: def.type, id: meta.id, payload: payload(), slug: def.slug && slug ? slug : undefined, mode, expectedVersion: meta.id ? meta.version : undefined }), (id) => { if (!def.singleton && !initial.id && id) router.replace(`/cms/${def.type}/${id}`); });
  const unpublish = () => meta.id && run(() => publicationAction({ id: meta.id!, version: meta.version, publish: false }));
  async function remove() {
    if (!meta.id || !window.confirm(`Hapus ${def.one} ini? Tindakan ini tidak dapat dibatalkan.`)) return;
    setBusy(true); const r = await deleteContentAction({ id: meta.id, type: def.type }); setBusy(false);
    if (r.ok) { setDirty(false); router.push(`/cms/${def.type}`); router.refresh(); } else setMsg({ kind: "bad", text: r.error });
  }

  const err = (path: string) => (errors[path] ? <p className="err" role="alert">{errors[path]}</p> : null);

  function control(f: FieldDef, value: unknown, set: (v: unknown) => void, path: string, id: string) {
    const common = { id, name: path, "aria-invalid": errors[path] ? true : undefined } as const;
    switch (f.kind) {
      case "textarea": case "richtext":
        return <><textarea {...common} value={String(value ?? "")} maxLength={f.max ? f.max + 200 : undefined} rows={f.kind === "richtext" ? 8 : 4} onChange={(e) => set(e.target.value)} />
          {f.kind === "richtext" ? <p className="muted">Format: **tebal**, *miring*, “- ” untuk daftar, [teks](https://tautan). HTML mentah tidak diizinkan.</p> : null}
          {f.max ? <p className="muted">{String(value ?? "").length}/{f.max}</p> : null}</>;
      case "select": return <select {...common} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>{!f.required ? <option value="">—</option> : null}{f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
      case "checkbox": return <label className="chk"><input {...common} type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} /> {f.label}</label>;
      case "datetime": return <input {...common} type="datetime-local" value={toLocalInput(value)} onChange={(e) => set(fromLocalInput(e.target.value))} />;
      case "date": return <input {...common} type="date" value={String(value ?? "")} onChange={(e) => set(e.target.value)} />;
      case "media": {
        const mid = typeof value === "string" ? value : "";
        return (
          <div className="mfield">
            {mid ? (f.accept === "pdf" ? <span className="pdf">PDF</span> : <img src={mediaUrl(mid)} alt="Pratinjau" />) : <span className="muted">Belum dipilih</span>}
            <div className="actions">
              <button className="btn sm" type="button" onClick={() => setPicker({ accept: f.accept, apply: (m) => set(m.id) })}>{mid ? "Ganti" : "Pilih / unggah"}</button>
              {mid ? <button className="btn sm danger" type="button" onClick={() => set("")}>Lepas</button> : null}
            </div>
          </div>
        );
      }
      default: return <input {...common} type={f.kind === "url" ? "url" : f.kind === "email" ? "email" : f.kind === "tel" ? "tel" : "text"} inputMode={f.kind === "year" ? "numeric" : undefined} placeholder={f.placeholder} value={String(value ?? "")} maxLength={f.max ? f.max + 100 : undefined} onChange={(e) => set(e.target.value)} />;
    }
  }

  function renderRepeater(f: FieldDef) {
    const trTab = lang === "en";
    const rows = (values[f.name] as Obj[] | undefined) ?? [];
    const enRows = (en[f.name] as Obj[] | undefined) ?? [];
    const setRows = (r: Obj[]) => setV(f.name, r);
    const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= rows.length) return; const n = [...rows]; [n[i], n[j]] = [n[j]!, n[i]!]; const e2 = [...enRows]; [e2[i], e2[j]] = [e2[j] ?? {}, e2[i] ?? {}]; setRows(n); setEn((p) => ({ ...p, [f.name]: e2 })); };
    return (
      <fieldset className="full rep" key={f.name}>
        <legend>{f.label}{f.required ? " *" : ""}</legend>
        {rows.map((row, i) => (
          <div className="repRow" key={i}>
            <div className="form2">
              {(f.sub ?? []).filter((s) => !trTab || s.tr).map((s) => (
                <div key={s.name}>
                  <label htmlFor={`${f.name}-${i}-${s.name}-${lang}`}>{s.label}{s.required && !trTab ? " *" : ""}</label>
                  {trTab ? <p className="muted src">ID: {String(row[s.name] ?? "—")}</p> : null}
                  {trTab
                    ? control(s, enRows[i]?.[s.name], (v) => { const e2 = [...enRows]; while (e2.length < rows.length) e2.push({}); e2[i] = { ...e2[i], [s.name]: v }; setE(f.name, e2); }, `_en.${f.name}.${i}.${s.name}`, `${f.name}-${i}-${s.name}-en`)
                    : control(s, row[s.name], (v) => { const n = [...rows]; n[i] = { ...n[i], [s.name]: v }; setRows(n); }, `${f.name}.${i}.${s.name}`, `${f.name}-${i}-${s.name}-id`)}
                  {err(trTab ? `_en.${f.name}.${i}.${s.name}` : `${f.name}.${i}.${s.name}`)}
                </div>
              ))}
            </div>
            {!trTab ? <div className="actions"><button className="btn sm" type="button" onClick={() => move(i, -1)} aria-label="Naikkan">↑</button><button className="btn sm" type="button" onClick={() => move(i, 1)} aria-label="Turunkan">↓</button><button className="btn sm danger" type="button" onClick={() => { setRows(rows.filter((_, k) => k !== i)); setEn((p) => ({ ...p, [f.name]: enRows.filter((_, k) => k !== i) })); }}>Hapus baris</button></div> : null}
          </div>
        ))}
        {!trTab ? <button className="btn sm" type="button" onClick={() => setRows([...rows, blankRow(f)])} disabled={rows.length >= 100}>+ Tambah baris</button> : null}
        {err(f.name)}
      </fieldset>
    );
  }

  const fields = def.fields.filter((f) => lang === "id" || f.tr || f.sub?.some((s) => s.tr));
  return (
    <div className="stack">
      {conflict ? <div className="flash bad" role="alert">Data ini sudah diubah di tab/sesi lain. Perubahan Anda belum disimpan. <button className="btn sm" type="button" onClick={() => window.location.reload()}>Muat ulang versi terbaru</button></div> : null}
      {msg && !conflict ? <p className={`flash ${msg.kind === "bad" ? "bad" : ""}`} role={msg.kind === "bad" ? "alert" : "status"}>{msg.text}</p> : null}
      {def.note ? <p className="muted">{def.note}</p> : null}
      {showTabs ? (
        <div className="tabs" role="tablist" aria-label="Bahasa konten">
          {(["id", "en"] as const).map((l) => <button key={l} role="tab" type="button" aria-selected={lang === l} className="tab" onClick={() => setLang(l)}>{l === "id" ? "Indonesia" : "English"}{l === defaultLang ? " · bahasa awal" : ""}</button>)}
        </div>
      ) : null}
      {lang === "en" ? <p className="muted">Terjemahan bahasa Inggris bersifat opsional. Kolom yang kosong akan menampilkan teks Indonesia di situs.</p> : null}
      <form className="card form2" noValidate onSubmit={(e) => { e.preventDefault(); void save("draft"); }}>
        {def.slug && lang === "id" ? <div className="full"><label htmlFor="slug">Slug URL</label><input id="slug" value={slug} placeholder="otomatis dari judul" maxLength={80} onChange={(e) => { setSlug(e.target.value.toLowerCase()); touch(); }} />{err("_slug")}</div> : null}
        {fields.map((f) => f.kind === "repeater" ? renderRepeater(f) : (
          <div key={f.name} className={f.full || f.kind === "checkbox" ? "full" : ""}>
            {f.kind !== "checkbox" ? <label htmlFor={`${f.name}-${lang}`}>{f.label}{f.required && lang === "id" ? " *" : ""}</label> : null}
            {lang === "en" ? <p className="muted src">ID: {String(values[f.name] ?? "—") || "—"}</p> : null}
            {lang === "en"
              ? control(f, en[f.name], (v) => setE(f.name, v), `_en.${f.name}`, `${f.name}-en`)
              : control(f, values[f.name], (v) => setV(f.name, v), f.name, `${f.name}-id`)}
            {err(lang === "en" ? `_en.${f.name}` : f.name)}
          </div>
        ))}
        <div className="full actions sticky">
          <button className="btn primary sm" type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Simpan draft"}</button>
          <button className="btn sm" type="button" disabled={busy} onClick={() => void save("publish")}>{meta.status === "published" || meta.status === "changed" ? "Simpan & terbitkan" : "Terbitkan"}</button>
          {meta.id && (meta.status === "published" || meta.status === "changed") ? <button className="btn sm" type="button" disabled={busy} onClick={() => void unpublish()}>Tarik ke draft</button> : null}
          {meta.id && !def.singleton ? <button className="btn sm danger" type="button" disabled={busy} onClick={() => void remove()}>Hapus</button> : null}
          <span className="muted">{meta.id ? `Status: ${meta.status === "changed" ? "terbit (ada perubahan draft)" : meta.status} · versi ${meta.version}` : "Belum disimpan"}{dirty ? " · ada perubahan belum disimpan" : ""}</span>
        </div>
      </form>
      <MediaPickerDialog open={!!picker} accept={picker?.accept} onClose={() => setPicker(null)} onPick={(m) => { picker?.apply(m); setPicker(null); touch(); }} />
    </div>
  );
}
