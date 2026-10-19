# Matriks tes ↔ PRD

Jalankan: `npm test` (butuh PostgreSQL; `scripts/dev-db.sh up` atau service container CI). 132 tes, ± 3 detik.

| PRD | Skenario | Berkas tes |
|---|---|---|
| AC01 / TEN01 | Hanya Super Admin yang dapat membuat tenant; slug cadangan/duplikat ditolak | `rbac.test.ts` (`tenant.manage`), `db-constraints.test.ts` (slug) |
| AC02 / TEN03 | Admin A tidak dapat membaca/ubah/hapus data B (ID asli, FK komposit, media, menu) | `db-isolation.test.ts` |
| AC05 / CMS13 | Halaman maks 20 blok (DB), slug cadangan | `db-constraints.test.ts` |
| AC06 / CMS15 | Tipe/ukuran media, key berprefiks tenant (batas DB) | `db-constraints.test.ts` |
| AC07 / WEB03 | Hostname ternormalisasi & unik global; host belum terverifikasi/tak dikenal ⇒ tak ada tenant | `db-constraints.test.ts`, `db-isolation.test.ts`, `security-utils.test.ts` |
| AC08 / ADM08 | Pembayaran sekali per invoice, referensi unik, invoice paid final, harga paket immutable | `db-constraints.test.ts` |
| AC10 / ADM09 | Impersonation ≤ 15 menit (DB), daftar larangan aksi (RBAC) | `db-constraints.test.ts`, `rbac.test.ts` |
| TEN02 | Satu admin aktif per tenant; sesi lama dicabut saat diganti | `db-constraints.test.ts`, `auth.test.ts` |
| §5.1 | Undangan sekali pakai 24 jam, kirim ulang mencabut yang lama | `auth.test.ts` |
| §10 | Matriks RBAC (pengunjung / admin / super / impersonation) per kapabilitas | `rbac.test.ts` |
| §10 | Reset sandi ≤ 30 menit, sekali pakai; re-auth ≤ 10 menit | `auth.test.ts` |
| §13.1 | CSP, header keamanan, Origin/CSRF | `security-utils.test.ts` |
| §13.2 | Normalisasi host (IDN, port, titik akhir) | `security-utils.test.ts` |
| ADM07 | Audit append-only | `db-constraints.test.ts` |
| ADM05 | Flag global unik / flag tenant perlu tenant | `db-constraints.test.ts` |
| AC01 / TEN01 | Provisioning idempoten & atomik; hanya Super Admin ber-MFA | `provisioning.test.ts` |
| AC03 / CMS | Isolasi konten antar sekolah, draft/terbit, slug unik, 409 konflik versi, tab EN | `content.test.ts` |
| AC06 / CMS15 | Pipeline media: presign, finalize, magic bytes, EICAR/PDF aktif, EXIF dibuang, kuota paralel, tak bisa hapus media terpakai | `media.test.ts` |
| AC09 / TEN04 | Sekolah ditangguhkan tak dapat mengubah konten/pengaturan | `content.test.ts`, `settings.test.ts` |
| AC13 / AC14 | Soft delete + pulih 30 hari; domain kustom diverifikasi ulang | `provisioning.test.ts` |
| §5.1 | Undangan lewat email antrean (token tersegel, dihapus setelah terkirim), kirim ulang, reset sandi lewat email | `provisioning.test.ts` |
| §11/§13 | Antrean job: dedupe, retry+backoff, dead-letter, SKIP LOCKED, pemulihan job macet | `provisioning.test.ts` |
| CMS pengaturan | Bahasa & Google Analytics: validasi ID GA4, isolasi antar sekolah | `settings.test.ts` |

Belum tercakup (fase berikutnya): AC04/AC15 (tema, halaman publik — Fase 3), AC11 (restore backup), AC12 (beban & aksesibilitas).
