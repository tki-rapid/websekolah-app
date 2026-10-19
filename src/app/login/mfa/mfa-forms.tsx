"use client";

import { useActionState, useState, useTransition } from "react";
import { confirmEnrollmentAction, startEnrollmentAction, verifyMfaAction, type FormState } from "../actions";

export function MfaForms({ enrolled }: { enrolled: boolean }) {
  return enrolled ? <Verify /> : <Enroll />;
}

function Verify() {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyMfaAction, {});
  return (
    <form action={action} noValidate>
      <p className="muted">Masukkan kode 6 digit dari aplikasi autentikator Anda.</p>
      <label htmlFor="code">Kode</label>
      <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus />
      {state.error ? <p className="err" role="alert">{state.error}</p> : null}
      <button className="btn primary" type="submit" disabled={pending}>Verifikasi</button>
    </form>
  );
}

function Enroll() {
  const [start, setStart] = useState<FormState>({});
  const [busy, startTransition] = useTransition();
  const [state, action, pending] = useActionState<FormState, FormData>(confirmEnrollmentAction, {});
  return (
    <div>
      <p className="muted">Akun Anda wajib memakai autentikasi dua langkah (TOTP). Pindai kode QR dengan Google Authenticator, 1Password, atau aplikasi serupa.</p>
      {!start.ok ? (
        <>
          <button className="btn primary" type="button" disabled={busy} onClick={() => startTransition(async () => setStart(await startEnrollmentAction()))}>Mulai pengaturan MFA</button>
          {start.error ? <p className="err" role="alert">{start.error}</p> : null}
        </>
      ) : (
        <form action={action} noValidate>
          {start.qr ? <img className="qr" src={start.qr} alt="Kode QR untuk aplikasi autentikator" /> : null}
          <p className="muted">Tidak bisa memindai? Masukkan kunci ini secara manual: <code>{start.secret}</code></p>
          <label htmlFor="code">Kode 6 digit</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
          {state.error ? <p className="err" role="alert">{state.error}</p> : null}
          <button className="btn primary" type="submit" disabled={pending}>Aktifkan MFA</button>
        </form>
      )}
    </div>
  );
}
