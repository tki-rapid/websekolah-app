import type { ContentType } from "@/generated/prisma/client";
import { hostOf, instagramCode, youtubeId } from "@/lib/content/social";

/**
 * Single source of truth for every CMS module (PRD §7): drives server validation AND the generated forms.
 * Unknown keys are dropped on write (no mass assignment). `tr` marks fields that get an English translation (payload._en).
 */
export type FieldKind = "text" | "textarea" | "richtext" | "date" | "datetime" | "select" | "media" | "url" | "email" | "tel" | "checkbox" | "year" | "repeater";
export interface FieldDef {
  name: string; label: string; kind: FieldKind;
  required?: boolean; max?: number; tr?: boolean; options?: [string, string][];
  accept?: "image" | "pdf"; sub?: FieldDef[]; hosts?: string[]; pathRe?: string; msg?: string; hint?: string; placeholder?: string; def?: unknown; full?: boolean;
}
export interface TypeDef {
  type: ContentType; label: string; one: string; route: string; titleField: string;
  slug?: boolean; ordered?: boolean; singleton?: boolean; feature?: "gallery" | "ppdb"; note?: string;
  fields: FieldDef[]; extra?: (p: Record<string, unknown>, errs: Record<string, string>) => void; defaults?: () => Record<string, unknown>;
}

const LEVELS = ["Sekolah", "Kecamatan", "Kota/Kabupaten", "Provinsi", "Nasional", "Internasional"];
const opts = (a: string[]): [string, string][] => a.map((x) => [x, x]);
const T = (name: string, label: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, label, kind: "text", ...o });

export const TYPES: Record<string, TypeDef> = {
  news: {
    type: "news", label: "Berita", one: "berita", route: "berita", slug: true, titleField: "title",
    fields: [
      T("title", "Judul", { required: true, max: 120, tr: true }),
      T("category", "Kategori", { kind: "select", options: opts(["Kegiatan", "Prestasi", "Akademik", "Pengumuman Umum"]) }),
      T("date", "Tanggal publik", { kind: "date", required: true }),
      T("summary", "Ringkasan", { kind: "textarea", required: true, max: 200, tr: true, full: true }),
      T("body", "Isi berita", { kind: "richtext", required: true, max: 8000, tr: true, full: true }),
      T("image", "Gambar utama", { kind: "media", accept: "image" }),
      T("instagramUrl", "Instagram (opsional)", { kind: "url", hosts: ["instagram.com"], pathRe: "^/(p|reel|tv)/[A-Za-z0-9_-]+", msg: "Gunakan tautan postingan Instagram (instagram.com/p/…, /reel/…, /tv/…)", placeholder: "https://www.instagram.com/p/…" }),
      T("facebookUrl", "Facebook (opsional)", { kind: "url", hosts: ["facebook.com", "fb.com", "fb.watch"], msg: "Gunakan tautan dari facebook.com / fb.watch" }),
      T("youtubeUrl", "YouTube (opsional)", { kind: "url", hosts: ["youtube.com", "youtu.be"], msg: "Gunakan tautan dari youtube.com / youtu.be" }),
      T("youtubeEmbed", "Tampilkan YouTube sebagai video yang bisa diputar di halaman", { kind: "checkbox", def: true }),
    ],
    defaults: () => ({ category: "Kegiatan", youtubeEmbed: true }),
    extra: (p, e) => { if (p.youtubeUrl && p.youtubeEmbed && !e.youtubeUrl && !youtubeId(String(p.youtubeUrl))) e.youtubeUrl = "Tautan ini bukan video, jadi tidak dapat diputar. Gunakan tautan video atau matikan opsi tampilkan sebagai video."; },
  },
  announcement: {
    type: "announcement", label: "Pengumuman", one: "pengumuman", route: "pengumuman", slug: true, titleField: "title",
    fields: [T("title", "Judul", { required: true, max: 120, tr: true }), T("date", "Tanggal", { kind: "date", required: true }), T("body", "Isi pengumuman", { kind: "richtext", required: true, max: 4000, tr: true, full: true }), T("attachment", "Lampiran (PDF, opsional)", { kind: "media", accept: "pdf" })],
  },
  agenda: {
    type: "agenda", label: "Agenda", one: "agenda", route: "agenda", slug: true, titleField: "title",
    fields: [T("title", "Judul kegiatan", { required: true, max: 120, tr: true }), T("start", "Mulai", { kind: "datetime", required: true }), T("end", "Selesai", { kind: "datetime", required: true }), T("location", "Lokasi", { max: 120, tr: true }), T("description", "Deskripsi", { kind: "richtext", max: 3000, tr: true, full: true })],
    extra: (p, e) => { if (p.start && p.end && !e.end && Date.parse(String(p.end)) < Date.parse(String(p.start))) e.end = "Waktu selesai tidak boleh sebelum waktu mulai"; },
  },
  staff: { type: "staff", label: "Guru & staf", one: "guru/staf", route: "guru", ordered: true, titleField: "name", note: "Kontak pribadi (telepon/email/alamat rumah) sengaja tidak tersedia sebagai field publik.", fields: [T("name", "Nama lengkap", { required: true, max: 100 }), T("position", "Jabatan", { required: true, max: 100, tr: true }), T("photo", "Foto", { kind: "media", accept: "image" })] },
  facility: { type: "facility", label: "Fasilitas", one: "fasilitas", route: "fasilitas", ordered: true, titleField: "name", fields: [T("name", "Nama fasilitas", { required: true, max: 100, tr: true }), T("description", "Deskripsi", { kind: "textarea", required: true, max: 400, tr: true, full: true }), T("photo", "Foto", { kind: "media", accept: "image" })] },
  achievement: {
    type: "achievement", label: "Prestasi", one: "prestasi", route: "prestasi", titleField: "title",
    fields: [T("title", "Judul prestasi", { required: true, max: 140, tr: true }), T("level", "Tingkat", { kind: "select", options: opts(LEVELS) }), T("year", "Tahun", { kind: "year", required: true }), T("description", "Deskripsi", { kind: "textarea", max: 400, tr: true, full: true }), T("photo", "Foto", { kind: "media", accept: "image" })],
    defaults: () => ({ level: "Sekolah", year: String(new Date().getFullYear()) }),
  },
  download: { type: "download", label: "Download", one: "dokumen", route: "download", titleField: "title", fields: [T("title", "Nama dokumen", { required: true, max: 120, tr: true }), T("category", "Kategori", { required: true, max: 40, tr: true }), T("file", "Berkas (PDF)", { kind: "media", accept: "pdf", required: true })] },
  gallery: {
    type: "gallery", label: "Galeri", one: "album", route: "galeri", slug: true, feature: "gallery", titleField: "title",
    fields: [T("title", "Judul album", { required: true, max: 100, tr: true }), T("description", "Deskripsi", { kind: "textarea", max: 300, tr: true, full: true }),
      { name: "photos", label: "Foto album", kind: "repeater", required: true, full: true, sub: [T("media", "Foto", { kind: "media", accept: "image", required: true }), T("caption", "Caption", { max: 120, tr: true }), T("alt", "Alt text", { required: true, max: 140, tr: true })] }],
  },
  profile: {
    type: "profile", label: "Profil sekolah", one: "profil", route: "profil", singleton: true, titleField: "name",
    fields: [T("name", "Nama sekolah", { required: true, max: 100 }), T("tagline", "Slogan", { max: 120, tr: true }), T("level", "Jenjang", { kind: "select", options: opts(["TK", "SD", "SMP", "SMA", "SMK", "Madrasah", "Pesantren", "Lainnya"]) }), T("npsn", "NPSN", { max: 12 }), T("accreditation", "Akreditasi", { kind: "select", options: opts(["A", "B", "C", "Belum"]) }), T("address", "Alamat", { required: true, max: 200 }),
      T("logo", "Logo", { kind: "media", accept: "image" }), T("heroImage", "Foto gedung/hero", { kind: "media", accept: "image" }), T("greetingName", "Nama kepala sekolah", { max: 100 }),
      T("greeting", "Sambutan kepala sekolah", { kind: "richtext", max: 3000, tr: true, full: true }), T("vision", "Visi", { kind: "richtext", max: 1000, tr: true, full: true }), T("mission", "Misi", { kind: "richtext", max: 2000, tr: true, full: true }), T("history", "Sejarah", { kind: "richtext", max: 4000, tr: true, full: true }),
      { name: "stats", label: "Statistik manual", kind: "repeater", full: true, sub: [T("label", "Label", { required: true, max: 30, tr: true }), T("value", "Nilai", { required: true, max: 12 })] }],
  },
  contact: {
    type: "contact", label: "Kontak", one: "kontak", route: "kontak", singleton: true, titleField: "email", note: "Kolom kosong tidak ditampilkan di situs publik. Protokol tautan hanya HTTPS.",
    fields: [T("phone", "Telepon", { kind: "tel" }), T("whatsapp", "WhatsApp", { kind: "tel" }), T("email", "Email", { kind: "email" }), T("address", "Alamat", { max: 200 }), T("hours", "Jam layanan", { max: 100, tr: true }), T("mapUrl", "Tautan peta (HTTPS)", { kind: "url" }), T("facebook", "Facebook (HTTPS)", { kind: "url", hosts: ["facebook.com", "fb.com"] }), T("instagram", "Instagram (HTTPS)", { kind: "url", hosts: ["instagram.com"] }), T("youtube", "YouTube (HTTPS)", { kind: "url", hosts: ["youtube.com", "youtu.be"] }), T("ctaLabel", "Label tombol CTA", { max: 40, tr: true }), T("ctaUrl", "Tujuan CTA (HTTPS)", { kind: "url" })],
  },
  ppdb: {
    type: "ppdb", label: "PPDB informatif", one: "PPDB", route: "ppdb", singleton: true, feature: "ppdb", titleField: "year", note: "MVP tidak mengumpulkan data pendaftar. Pendaftaran dilakukan lewat kanal eksternal.",
    fields: [T("status", "Status pendaftaran", { kind: "select", options: [["open", "Dibuka"], ["closed", "Ditutup"]], required: true }), T("year", "Tahun ajaran", { required: true, max: 12, placeholder: "2026/2027" }), T("periodStart", "Periode mulai", { kind: "date", required: true }), T("periodEnd", "Periode berakhir", { kind: "date", required: true }),
      T("intro", "Pengantar", { kind: "richtext", required: true, max: 2000, tr: true, full: true }), T("requirements", "Persyaratan (satu per baris)", { kind: "textarea", required: true, max: 1500, tr: true, full: true }),
      { name: "schedule", label: "Jadwal", kind: "repeater", full: true, sub: [T("label", "Kegiatan", { required: true, max: 80, tr: true }), T("date", "Tanggal", { kind: "date", required: true })] },
      { name: "files", label: "Berkas unduhan", kind: "repeater", full: true, sub: [T("name", "Nama berkas", { required: true, max: 80, tr: true }), T("media", "PDF", { kind: "media", accept: "pdf", required: true })] },
      T("ctaLabel", "Label tombol daftar", { max: 50, tr: true }), T("ctaUrl", "Tautan pendaftaran eksternal (HTTPS)", { kind: "url" })],
    extra: (p, e) => {
      if (p.periodStart && p.periodEnd && !e.periodEnd && String(p.periodEnd) < String(p.periodStart)) e.periodEnd = "Periode berakhir tidak boleh sebelum mulai";
      if (p.status === "open" && !p.ctaUrl && !e.ctaUrl) e.ctaUrl = "Status dibuka memerlukan tautan pendaftaran";
    },
  },
  seo: { type: "seo", label: "SEO situs", one: "SEO", route: "", singleton: true, titleField: "siteTitle", fields: [T("siteTitle", "Judul situs", { required: true, max: 70 }), T("siteDescription", "Deskripsi situs", { kind: "textarea", max: 160 })] },
};

export const MODULE_ORDER = ["news", "announcement", "agenda", "staff", "facility", "achievement", "download", "gallery"] as const;
export const SINGLETON_ORDER = ["profile", "contact", "ppdb"] as const;
export const typeDef = (t: string): TypeDef | null => TYPES[t] ?? null;
export const translatableFields = (d: TypeDef) => d.fields.filter((f) => f.tr || (f.kind === "repeater" && f.sub?.some((s) => s.tr)));
/** Keys that must be translated for English to count as "complete". */
export const requiredTranslationKeys = (d: TypeDef) => d.fields.filter((f) => f.tr && f.required).map((f) => f.name);
export { hostOf, instagramCode };
