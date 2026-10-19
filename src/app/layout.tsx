import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WebSekolah", template: "%s · WebSekolah" },
  description: "Platform website sekolah — fondasi aman (Fase 1).",
  robots: { index: false, follow: false }, // the platform app itself is not indexed; school sites set their own robots
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Opt every page into dynamic rendering: the CSP nonce (src/proxy.ts) is per-request, and a statically
  // prerendered page could never carry it — its scripts would be blocked by `strict-dynamic`.
  await connection();
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
