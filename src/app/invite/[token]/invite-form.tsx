"use client";

import { useActionState } from "react";
import { acceptInviteAction, type FormState } from "../../login/actions";

export default function InviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(acceptInviteAction, {});
  return (
    <form action={action} noValidate>
      <input type="hidden" name="token" value={token} />
      <label htmlFor="password">Kata sandi baru</label>
      <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      <p className="muted">Minimal 12 karakter. Frasa sandi panjang lebih aman daripada simbol acak.</p>
      <label htmlFor="confirm">Ulangi kata sandi</label>
      <input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button className="btn primary" type="submit" disabled={pending}>Aktifkan akun</button>
    </form>
  );
}
