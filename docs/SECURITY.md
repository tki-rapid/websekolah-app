# Keamanan — kontrol, batas, dan daftar periksa go-live

> Dokumen ini jujur tentang apa yang **sudah ditegakkan & diuji** dan apa yang **belum**. "Aman" tidak dapat dijamin oleh pengembang
> saja: pentest independen dan review keamanan wajib sebelum produksi (PRD §14 gate produksi).

## Kontrol yang sudah ada (dengan bukti tes)
| Risiko (PRD) | Kontrol | Tes |
|---|---|---|
| R02 kebocoran tenant | RLS `FORCE` + dua login DB + FK komposit `(tenant_id,id)` + trigger `tenant_id` immutable | `db-isolation.test.ts` (uji mutasi: tes gagal bila policy dilemahkan) |
| IDOR (AC02) | baca/ubah/hapus ID tenant lain ⇒ 0 baris, bukan error informatif | idem |
| TEN02 satu admin aktif | partial unique index | `db-constraints.test.ts` |
| Brute force / enumerasi | rate limit per-IP & per-akun (PostgreSQL), pesan gagal seragam, kerja konstan Argon2 untuk akun tak ada | `auth.test.ts` |
| Sesi dicuri/ganti admin | token acak hash-only, TTL absolut + idle, cabut seketika, dicabut saat reset sandi/nonaktif | `auth.test.ts` |
| MFA Super Admin | TOTP, seed terenkripsi AES-GCM, anti-replay (`totp_last_step` atomik), lockout | `auth.test.ts`, `rbac.test.ts` |
| Takeover via Google | hanya `email_verified`, ikat ke `sub`, `sub` berbeda ditolak, tanpa registrasi mandiri, aktivasi hanya dengan undangan valid | `auth.test.ts` |
| Undangan (PRD §5.1) | sekali pakai atomik, 24 jam, kirim ulang mencabut token lama, tak bisa membajak akun aktif | `auth.test.ts` |
| CSRF | cookie `SameSite=Lax` + cek Origin + server actions Next | `security-utils.test.ts` |
| XSS/CSP (§13.1) | CSP nonce + strict-dynamic, tanpa `unsafe-inline` script, `frame-ancestors none`, `object-src none` | `security-utils.test.ts`, uji curl |
| SSRF/host (§13.2) | normalisasi host, tolak IP/port/path, host tak dikenal ⇒ tidak ada tenant default | `security-utils.test.ts`, `db-isolation.test.ts` |
| Integritas billing (R05) | versi paket immutable, invoice final, pembayaran 1× per invoice & referensi unik, jumlah harus sama | `db-constraints.test.ts` |
| Audit (ADM07) | append-only via trigger + tanpa grant UPDATE/DELETE/TRUNCATE | `db-constraints.test.ts` |
| Rahasia | validasi env fail-fast, semua rahasia di Secret Manager, tidak ada rahasia/token di log audit | `security-utils.test.ts`, `auth.test.ts` |
| Waktu | sesi DB dipaksa UTC (bug nyata tertangkap: zona server ≠ UTC menggeser kedaluwarsa) | `db-isolation.test.ts` |
| Kebocoran arsitektur | ESLint melarang kode UI mengimpor klien DB / `platformClient` | probe lint |

## Batas yang disengaja / belum dibangun (JANGAN dianggap selesai)
- **Login Google belum diuji dengan kredensial Google nyata.** Yang teruji: pembuatan URL otorisasi (state, PKCE, cookie), validasi klaim, `resolveGoogleLogin` (semua cabang). Yang belum: pertukaran kode ke Google (butuh OAuth client Anda).
- **Email** belum terhubung (undangan/reset): fungsinya mengembalikan token mentah; pengiriman email (mis. Gmail API/SendGrid) = Fase 2.
- **Media upload, pemindaian malware, sanitasi rich text, SSRF worker DNS**: Fase 2–4 (constraint DB untuk tipe/ukuran/prefix key sudah ada).
- **Impersonation**: model data + RBAC + batas 15 menit di DB siap; alur UI/sesi Fase 4.
- **Tidak ada WAF/Cloud Armor** (perlu HTTPS Load Balancer — rencana Fase 4 bersama custom domain).
- **Docker image belum dibangun/dipindai di mesin ini** (Docker Desktop dalam keadaan paused). CI membangun & memindai (Trivy) pada PR.
- **Terraform** tervalidasi (`tofu validate`) tetapi **belum di-apply** ke proyek GCP nyata.
- Batas rate limit & TTL sesi adalah nilai awal; tetapkan bersama pemilik produk.
- TOTP: tidak ada kode pemulihan (rencana: dua Super Admin + prosedur reset oleh pemilik platform).

## Daftar periksa sebelum produksi
1. Pentest independen + tinjau hasil; perbaiki temuan High/Critical.
2. Uji restore backup (RTO 8 jam, RPO 24 jam) dan simpan buktinya (AC11).
3. Terapkan Terraform ke proyek staging → jalankan job bootstrap & migrate → smoke test login Google/sandi/MFA.
4. Aktifkan Cloud Audit Logs (Data Access untuk Secret Manager & Cloud SQL), alarm 5xx/latensi/DB, uptime check.
5. Batasi IAM: hapus peran Owner dari akun harian, pakai Workload Identity untuk CI, tinjau `allUsers` hanya pada layanan publik.
6. Tetapkan retensi data & kebijakan privasi (PRD §13.3) dan penanggung jawab data.
7. Uji beban (NFR01) dan aksesibilitas komponen inti (NFR06) pada Fase 3.
8. Rotasi rahasia terjadwal (APP_SECRET menggeser hash IP: aman; TOTP_ENC_KEY: perlu migrasi enkripsi ulang — jangan diganti tanpa prosedur).

## Tambahan Fase 2
| Ancaman | Kontrol |
|---|---|
| Unggah berbahaya (polyglot, SVG/HTML, bom piksel, EXIF/GPS bocor) | Allow-list MIME (JPG/PNG/WebP/PDF), cek magic bytes saat finalize, batas ukuran & piksel, pemindai konten aktif (PDF `/JS`, `/Launch`, EICAR), re-encode `sharp` (metadata dibuang), nama objek acak berprefiks tenant, bucket `public_access_prevention=enforced`, pratinjau disajikan dengan `nosniff` + CSP `sandbox` |
| Kuota dijebol dengan unggahan paralel | Reservasi kuota atomik di bawah `pg_advisory_xact_lock` saat presign; reservasi kedaluwarsa dibersihkan pekerja |
| Upload endpoint lokal disalahgunakan | HMAC atas key/exp/content-type/max-bytes; batas byte saat streaming; 404 di produksi (GCS) |
| XSS lewat konten | Tidak ada HTML mentah: ditolak saat tulis, di-escape saat render (Markdown subset); tautan sosial dibatasi domain & HTTPS |
| Penimpaan diam-diam oleh dua editor | Kunci versi optimistis ⇒ 409 |
| Token undangan/reset bocor lewat DB/log | Hanya hash di tabel token; token mentah hanya di payload job tersegel AES-GCM, dihapus setelah terkirim; email dev tidak dikirim ke luar |
| Enumerasi akun via “lupa sandi” | Respons identik; batas laju per IP dan per email |
| Penyalahgunaan aksi sensitif dengan sesi curian | Re-auth (TOTP bila MFA aktif, kata sandi bila tidak) ≤ 10 menit untuk tangguhkan/hapus/ganti admin; kode TOTP tidak dapat diputar ulang |
| Pembuatan tenant ganda (klik ganda/retry) | Kunci idempotensi per form |
| Endpoint pekerja terbuka | 404 bila token tak diset; bearer token dibandingkan *constant-time*; token di Secret Manager |
| Parameter URL tidak tepercaya | Semua `[id]` divalidasi UUID sebelum menyentuh DB; tenant selalu dari sesi |
| Unggah langsung ke GCS | CSP `connect-src` hanya mengizinkan `storage.googleapis.com` pada rute `/cms`; CORS bucket hanya origin aplikasi, hanya `PUT` |
