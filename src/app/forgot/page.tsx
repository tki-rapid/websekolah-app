import type { Metadata } from "next";
import ForgotForm from "./forgot-form";

export const metadata: Metadata = { title: "Lupa kata sandi", robots: { index: false, follow: false } };

export default function ForgotPage() {
  return (
    <main>
      <div className="card narrow">
        <h1>Lupa kata sandi</h1>
        <p className="muted">Masukkan email akun Anda. Jika terdaftar, kami mengirim tautan reset yang berlaku 30 menit.</p>
        <ForgotForm />
        <p><a href="/login">Kembali ke halaman masuk</a></p>
      </div>
    </main>
  );
}
