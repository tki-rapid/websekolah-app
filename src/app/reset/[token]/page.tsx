import type { Metadata } from "next";
import ResetForm from "./reset-form";

export const metadata: Metadata = { title: "Atur kata sandi baru", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main>
      <div className="card narrow">
        <h1>Atur kata sandi baru</h1>
        <p className="muted">Setelah disimpan, semua sesi lama akan keluar otomatis.</p>
        <ResetForm token={token} />
      </div>
    </main>
  );
}
