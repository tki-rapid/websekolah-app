import Link from "next/link";

export default function Home() {
  return (
    <main>
      <div className="card narrow">
        <h1>WebSekolah</h1>
        <p className="muted">Fondasi aman platform website sekolah (Fase 1): isolasi tenant, autentikasi (Google, kata sandi, TOTP), RBAC, dan audit.</p>
        <Link className="btn primary" href="/login">Masuk</Link>
      </div>
    </main>
  );
}
