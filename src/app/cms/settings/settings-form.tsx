"use client";

import { useActionState } from "react";
import { saveSettingsAction, type SettingsState } from "../actions";

type S = { enableEn: boolean; defaultLang: "id" | "en"; showLangSwitcher: boolean; gaEnabled: boolean; gaMeasurementId: string; gaRequireConsent: boolean; gaSkipAdmins: boolean };

export default function SettingsForm({ s }: { s: S }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveSettingsAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <div className="card">
        <h2>Bahasa situs</h2>
        <p className="muted">Konten Indonesia selalu tersedia. Aktifkan English untuk menampilkan tab terjemahan di editor dan pilihan bahasa di situs. Tersedia untuk semua paket.</p>
        <label className="chk"><input type="checkbox" name="enableEn" defaultChecked={s.enableEn} /> Aktifkan bahasa Inggris</label>
        <label htmlFor="defaultLang">Bahasa awal situs</label>
        <select id="defaultLang" name="defaultLang" defaultValue={s.defaultLang}><option value="id">Indonesia</option><option value="en">English</option></select>
        {f.defaultLang ? <p className="err" role="alert">{f.defaultLang}</p> : null}
        <label className="chk"><input type="checkbox" name="showLangSwitcher" defaultChecked={s.showLangSwitcher} /> Tampilkan pengalih bahasa di situs</label>
      </div>
      <div className="card">
        <h2>Google Analytics</h2>
        <p className="muted">Opsional. Masukkan ID pengukuran GA4 milik sekolah Anda (G-XXXXXXXXXX). Skrip hanya dimuat di situs publik, tidak di CMS.</p>
        <label className="chk"><input type="checkbox" name="gaEnabled" defaultChecked={s.gaEnabled} /> Aktifkan Google Analytics</label>
        <label htmlFor="gaMeasurementId">ID pengukuran</label>
        <input id="gaMeasurementId" name="gaMeasurementId" defaultValue={s.gaMeasurementId} placeholder="G-XXXXXXXXXX" maxLength={14} autoComplete="off" />
        {f.gaMeasurementId ? <p className="err" role="alert">{f.gaMeasurementId}</p> : null}
        <label className="chk"><input type="checkbox" name="gaRequireConsent" defaultChecked={s.gaRequireConsent} /> Minta persetujuan pengunjung (disarankan)</label>
        <label className="chk"><input type="checkbox" name="gaSkipAdmins" defaultChecked={s.gaSkipAdmins} /> Jangan hitung kunjungan admin</label>
      </div>
      {state.error && !state.fields ? <p className="err" role="alert">{state.error}</p> : null}
      {state.ok ? <p className="flash" role="status">{state.ok}</p> : null}
      <div><button className="btn primary inline" type="submit" disabled={pending}>{pending ? "Menyimpan…" : "Simpan pengaturan"}</button></div>
    </form>
  );
}
