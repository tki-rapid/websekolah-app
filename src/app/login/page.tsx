import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/cookies";
import { isFullyAuthenticated } from "@/lib/auth/session";
import { googleConfigured } from "@/lib/auth/google";
import LoginForm from "./login-form";

export const metadata: Metadata = { title: "Masuk" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  google_denied: "Akun Google ini belum terdaftar atau tidak dapat digunakan. Hubungi operator sekolah/platform.",
  google_unavailable: "Login dengan Google belum dikonfigurasi.",
  google_state: "Sesi login Google tidak valid atau kedaluwarsa. Silakan coba lagi.",
  forbidden: "Anda tidak memiliki akses ke halaman tersebut.",
  origin: "Permintaan ditolak (asal tidak valid).",
  rate_limited: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; reset?: string }> }) {
  const ctx = await getSession();
  if (ctx) redirect(!isFullyAuthenticated(ctx) ? "/login/mfa" : ctx.user.role === "SUPER_ADMIN" ? "/super" : "/cms");
  const { error, reset } = await searchParams;
  return (
    <main>
      <div className="card narrow">
        <h1>Masuk</h1>
        {reset ? <p className="ok" role="status">Kata sandi diperbarui. Silakan masuk.</p> : null}
        {error && ERRORS[error] ? <p className="err" role="alert">{ERRORS[error]}</p> : null}
        {googleConfigured() ? (
          <>
            <a className="btn" href="/api/auth/google/start">Lanjutkan dengan Google</a>
            <div className="sep">atau</div>
          </>
        ) : null}
        <LoginForm />
        <p><a href="/forgot">Lupa kata sandi?</a></p>
        <p className="muted">Tidak ada pendaftaran mandiri: akun sekolah dibuat oleh operator dan diaktifkan lewat undangan.</p>
      </div>
    </main>
  );
}
