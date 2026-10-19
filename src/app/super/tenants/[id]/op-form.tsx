"use client";

import { useActionState } from "react";
import { tenantOpAction, type SuperState } from "../../actions";

type Field = { name: string; label: string; type?: string; placeholder?: string; textarea?: boolean };

/** One lifecycle operation as a small form: hidden tenant id + op, optional fields, inline result. */
export default function OpForm({ tenantId, op, label, fields = [], danger, hint }: { tenantId: string; op: string; label: string; fields?: Field[]; danger?: boolean; hint?: string }) {
  const [state, action, pending] = useActionState<SuperState, FormData>(tenantOpAction, {});
  return (
    <form action={action} noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="op" value={op} />
      {hint ? <p className="muted">{hint}</p> : null}
      {fields.map((f) => (
        <div key={f.name}>
          <label htmlFor={`${op}-${f.name}`}>{f.label}</label>
          {f.textarea ? <textarea id={`${op}-${f.name}`} name={f.name} required /> : <input id={`${op}-${f.name}`} name={f.name} type={f.type ?? "text"} placeholder={f.placeholder} required />}
        </div>
      ))}
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      {state.ok ? <p className="ok" role="status">{state.ok}</p> : null}
      <p><button className={`btn sm ${danger ? "danger" : ""}`} type="submit" disabled={pending}>{pending ? "Memproses…" : label}</button></p>
    </form>
  );
}
