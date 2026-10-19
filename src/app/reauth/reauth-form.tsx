"use client";

import { useActionState } from "react";
import { reauthAction, type FormState } from "../login/actions";

export default function ReauthForm({ next, totp }: { next: string; totp: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(reauthAction, {});
  return (
    <form action={action} noValidate>
      <input type="hidden" name="next" value={next} />
      {totp ? (
        <>
          <label htmlFor="code">Kode autentikator</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
        </>
      ) : (
        <>
          <label htmlFor="password">Kata sandi</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </>
      )}
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button className="btn primary" type="submit" disabled={pending}>Konfirmasi</button>
    </form>
  );
}
