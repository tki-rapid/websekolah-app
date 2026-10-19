"use client";

import { useActionState } from "react";
import { forgotPasswordAction, type FormState } from "../login/actions";

export default function ForgotForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPasswordAction, {});
  if (state.ok) return <p className="ok" role="status">Jika email terdaftar, tautan reset sudah dikirim. Periksa kotak masuk Anda.</p>;
  return (
    <form action={action} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required />
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Mengirim…" : "Kirim tautan reset"}</button>
    </form>
  );
}
