import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listPlans, SCHOOL_TYPES } from "@/lib/services/provisioning";
import NewTenantForm from "./new-form";

export const metadata: Metadata = { title: "Sekolah baru" };
export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  await requireSuperAdmin();
  const plans = await listPlans();
  // One idempotency key per rendered form: a double click or a retried submit can never create two schools.
  return (
    <main>
      <h1>Sekolah baru</h1>
      <p className="muted">Sekolah dibuat berstatus PROVISIONING; admin menerima email undangan (berlaku 24 jam) untuk mengaktifkan akun.</p>
      <div className="card"><NewTenantForm idem={randomUUID()} plans={plans} types={[...SCHOOL_TYPES]} /></div>
    </main>
  );
}
