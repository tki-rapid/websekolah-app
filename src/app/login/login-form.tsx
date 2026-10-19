"use client";

import { useActionState } from "react";
import { passwordLoginAction, type FormState } from "./actions";

export default function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(passwordLoginAction, {});
  return (
    <form action={action} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required />
      <label htmlFor="password">Kata sandi</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Memproses…" : "Masuk"}</button>
    </form>
  );
}
