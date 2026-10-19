import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/cookies";
import ReauthForm from "./reauth-form";

export const metadata: Metadata = { title: "Konfirmasi identitas", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ReauthPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  const { next } = await searchParams;
  return (
    <main>
      <div className="card narrow">
        <h1>Konfirmasi identitas</h1>
        <p className="muted">Aksi ini sensitif. {ctx.user.totpEnabled ? "Masukkan kode 6 digit dari aplikasi autentikator Anda." : "Masukkan kata sandi Anda."}</p>
        <ReauthForm next={next ?? ""} totp={ctx.user.totpEnabled} />
      </div>
    </main>
  );
}
