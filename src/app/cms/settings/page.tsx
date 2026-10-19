import type { Metadata } from "next";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { getSettings } from "@/lib/services/settings";
import SettingsForm from "./settings-form";

export const metadata: Metadata = { title: "Pengaturan" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { ctx } = await requireSchoolAdmin();
  const s = await getSettings(actorOf(ctx));
  return (
    <main>
      <h1>Pengaturan</h1>
      <SettingsForm s={{ enableEn: s.enableEn, defaultLang: s.defaultLang as "id" | "en", showLangSwitcher: s.showLangSwitcher, gaEnabled: s.gaEnabled, gaMeasurementId: s.gaMeasurementId ?? "", gaRequireConsent: s.gaRequireConsent, gaSkipAdmins: s.gaSkipAdmins }} />
    </main>
  );
}
