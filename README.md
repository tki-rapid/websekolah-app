# WebSekolah — platform (Fase 1–2: fondasi aman + inti CMS)

Multi-tenant SaaS untuk website sekolah. Repo ini adalah **fondasi produksi** dari prototipe `../websekolah` (prototipe = spesifikasi desain & alur; kode di sini = implementasi sebenarnya).

**Stack:** Next.js 16 (App Router, TypeScript) · PostgreSQL 16 + Prisma 7 · Row Level Security · Login Google (OIDC + PKCE) · Argon2id · TOTP MFA · Cloud Run / Cloud SQL / Secret Manager (GCP).

## Yang sudah ada di Fase 1
| Area | Isi |
|---|---|
| Data | Skema PRD §12 lengkap, migrasi SQL, constraint/trigger integritas (invoice, audit append-only, versi paket immutable, batas 20 blok, kedalaman menu 3, dst.) |
| Isolasi tenant | RLS `FORCE` di semua tabel milik sekolah; dua login DB terpisah (tenant vs platform); `withTenant()`; fungsi `resolve_host()` sebagai satu-satunya jalur lintas tenant dari kode tenant |
| Auth | Login Google (tanpa registrasi mandiri), email+sandi (Argon2id), undangan sekali pakai 24 jam, reset sandi 30 menit, TOTP MFA wajib Super Admin (anti-replay), sesi server-side yang bisa dicabut, rate limit di PostgreSQL |
| Otorisasi | Matriks RBAC PRD §10 sebagai kode + tes; guard server untuk setiap halaman/aksi |
| Hardening | CSP bernonce + strict-dynamic, HSTS, header keamanan, cek Origin (CSRF), cookie `__Host-` HttpOnly Secure, validasi env fail-fast, lint yang melarang akses DB mentah dari kode UI |
| Operasi | Dockerfile (app/migrate/bootstrap), Cloud Build, Terraform GCP, CI GitHub Actions, seed |
| Tes | 132 tes integrasi/unit terhadap PostgreSQL sungguhan (lihat `docs/TEST-MATRIX.md`) |

Belum ada (Fase 2+): modul CMS, situs publik/tema, halaman blok, media upload, billing/domain/impersonation (alur UI), worker — lihat `docs/ARCHITECTURE.md` §Roadmap.

## Yang ditambahkan di Fase 2 (inti CMS)
- **Provisioning tenant** oleh Super Admin (`/super/tenants`): idempoten (kunci idempotensi), tenant + admin + langganan + tema + subdomain + beranda + invoice draft dalam satu transaksi; undangan dikirim lewat **antrean pekerjaan** durable (token hanya ada terenkripsi di payload job, dihapus setelah terkirim). Aktivasi, tangguhkan, hapus (soft delete, pulih 30 hari), ganti admin (sesi lama dicabut), kirim ulang undangan — aksi sensitif memerlukan **re-auth ≤ 10 menit** (`/reauth`).
- **Modul konten** (berita, pengumuman, agenda, guru, fasilitas, prestasi, download, galeri, profil, kontak, PPDB): form dibangkitkan dari satu registri skema (`src/lib/content/types.ts`) yang juga menjadi validator server; **draft/terbit terpisah**, tab **ID/EN**, slug unik, **kunci versi optimistis (409)**, rich text aman (Markdown subset, HTML mentah ditolak), referensi media terlacak.
- **Media aman**: presign → unggah langsung ke storage privat (GCS V4 signed URL; dev: URL bertanda tangan HMAC lokal) → finalize (cek magic bytes, ukuran, pemindaian, re-encode tanpa EXIF, thumbnail, checksum). Kuota dipesan atomik; file yang dipakai tak bisa dihapus.
- **Audit** di transaksi yang sama dengan perubahan; halaman Aktivitas per sekolah; **Pengaturan** bahasa (ID/EN) dan Google Analytics.
- **Lupa kata sandi** via email (`/forgot`, `/reset/[token]`), tanpa enumerasi akun, dibatasi laju.
- Endpoint pekerja `POST /api/internal/jobs/run` (Cloud Scheduler, bearer token) menjalankan antrean email, membersihkan reservasi unggahan kedaluwarsa, dan memurnikan rate-limit.

Variabel lingkungan baru: `SMTP_URL`, `MAIL_FROM`, `JOB_RUNNER_TOKEN`, `MEDIA_BACKEND`, `MEDIA_BUCKET`, `MEDIA_LOCAL_DIR` (lihat `.env.example`). Di dev, email dicetak ke log server dan media disimpan di `.media-dev/`. Helper dev untuk kode TOTP: `NODE_OPTIONS=--conditions=react-server npx tsx scripts/dev-totp.ts <email>`.

## Mulai cepat (lokal, tanpa Docker)
```bash
npm ci
scripts/dev-db.sh up                 # PostgreSQL lokal :54329 + peran DB + migrasi
cp .env.example .env.local           # isi APP_SECRET & TOTP_ENC_KEY: openssl rand -base64 48
set -a; . ./.env.local; set +a
SEED_DEMO=1 SEED_SUPERADMIN_EMAIL=anda@contoh.id SEED_SUPERADMIN_PASSWORD='frasa-sandi-panjang-anda' npm run db:seed
npm run dev                          # http://localhost:3000
npm run check                        # typecheck + lint + 132 tes
```
Alternatif DB: `docker compose up -d db` (lihat `docker-compose.yml`).

## Struktur
```
prisma/            schema.prisma, migrations (init · security · totp_replay), seed.ts
scripts/           dev-db.sh, db-bootstrap.sql (peran DB), bootstrap/init untuk Docker
src/proxy.ts       CSP nonce + header keamanan + validasi Host
src/lib/db.ts      SATU-satunya tempat membuat klien DB (withTenant, platformClient)
src/lib/auth/      session, login, google, totp, invitations, password-reset, rbac, guards
src/lib/security/  password, crypto, tokens, ratelimit, hostname, csp, request
src/lib/dal/       akses data per peran (tenant = RLS; platform = lintas tenant + cek RBAC)
src/app/           login, MFA, undangan, /cms, /super, /api/health, /api/auth/google/*
tests/             integrasi (RLS, constraint, auth, RBAC, utilitas keamanan)
infra/terraform/   GCP: VPC, Cloud SQL privat, Secret Manager, Cloud Run, GCS, IAM
docs/              ARCHITECTURE, SECURITY, GCP-SETUP, TEST-MATRIX, DECISIONS
```
