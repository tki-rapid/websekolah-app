import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/cookies";
import { isFullyAuthenticated } from "@/lib/auth/session";
import { MfaForms } from "./mfa-forms";
import { logoutAction } from "../actions";

export const metadata: Metadata = { title: "Verifikasi MFA" };
export const dynamic = "force-dynamic";

export default async function MfaPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  if (isFullyAuthenticated(ctx)) redirect(ctx.user.role === "SUPER_ADMIN" ? "/super" : "/cms");
  return (
    <main>
      <div className="card narrow">
        <h1>Verifikasi dua langkah</h1>
        <MfaForms enrolled={ctx.user.totpEnabled} />
        <form action={logoutAction}><button className="btn" type="submit">Batal dan keluar</button></form>
      </div>
    </main>
  );
}
