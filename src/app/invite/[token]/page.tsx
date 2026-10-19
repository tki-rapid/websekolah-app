import type { Metadata } from "next";
import { peekInvitation } from "@/lib/auth/invitations";
import { googleConfigured } from "@/lib/auth/google";
import InviteForm from "./invite-form";

export const metadata: Metadata = { title: "Aktifkan akun", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await peekInvitation(token);
  return (
    <main>
      <div className="card narrow">
        {inv.state === "valid" ? (
          <>
            <h1>Aktifkan akun</h1>
            <p className="muted">Admin <b>{inv.schoolName}</b> — akun <b>{inv.email}</b>. Undangan berlaku sampai {inv.expiresAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB.</p>
            {googleConfigured() ? (<><a className="btn" href="/api/auth/google/start">Aktifkan dengan Google</a><div className="sep">atau buat kata sandi</div></>) : null}
            <InviteForm token={token} />
          </>
        ) : (
          <>
            <h1>Undangan tidak dapat digunakan</h1>
            <p className="muted">
              {inv.state === "expired" ? "Undangan ini sudah kedaluwarsa (berlaku 24 jam). Minta operator mengirim ulang." : inv.state === "used" ? "Undangan ini sudah dipakai. Silakan masuk." : "Tautan undangan tidak valid."}
            </p>
            <a className="btn" href="/login">Ke halaman masuk</a>
          </>
        )}
      </div>
    </main>
  );
}
