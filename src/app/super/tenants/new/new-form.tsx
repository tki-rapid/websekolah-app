"use client";

import { useActionState } from "react";
import { createTenantAction, type SuperState } from "../../actions";

type Plan = { code: string; name: string; interval: string; amount: number };
const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

export default function NewTenantForm({ idem, plans, types }: { idem: string; plans: Plan[]; types: string[] }) {
  const [state, action, pending] = useActionState<SuperState, FormData>(createTenantAction, {});
  const f = state.fields ?? {};
  const err = (k: string) => (f[k] ? <p className="err" role="alert">{f[k]}</p> : null);
  return (
    <form action={action} noValidate className="form2">
      <input type="hidden" name="idem" value={idem} />
      <div className="full"><label htmlFor="name">Nama sekolah</label><input id="name" name="name" required maxLength={100} />{err("name")}</div>
      <div><label htmlFor="slug">Subdomain (slug)</label><input id="slug" name="slug" required maxLength={40} placeholder="sma-harapan" />{err("slug")}<p className="muted">Hasil: slug.websekolah.id</p></div>
      <div><label htmlFor="type">Jenis</label><select id="type" name="type">{types.map((t) => <option key={t}>{t}</option>)}</select>{err("type")}</div>
      <div><label htmlFor="plan">Paket &amp; periode</label>
        <select id="plan" name="plan">
          {plans.map((p) => <option key={`${p.code}:${p.interval}`} value={`${p.code}:${p.interval}`}>{p.name} · {p.interval === "MONTHLY" ? "bulanan" : "tahunan"} · {rp(p.amount)}</option>)}
        </select>
        {err("planCode")}
      </div>
      <div><label htmlFor="adminName">Nama admin sekolah</label><input id="adminName" name="adminName" required maxLength={80} />{err("adminName")}</div>
      <div><label htmlFor="adminEmail">Email admin</label><input id="adminEmail" name="adminEmail" type="email" required maxLength={254} />{err("adminEmail")}</div>
      <div className="full">
        {state.error ? <p className="err" role="alert">{state.error}</p> : null}
        <button className="btn primary inline" type="submit" disabled={pending}>{pending ? "Membuat…" : "Buat sekolah & kirim undangan"}</button>
      </div>
    </form>
  );
}
