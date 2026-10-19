# Arsitektur (Fase 1–2)

```
Browser ──HTTPS──► Cloud Run (Next.js standalone, 1 vCPU/1 GiB, min 1 instance)
                     │  src/proxy.ts: validasi Host · CSP nonce · header keamanan
                     │  halaman/aksi: requireSchoolAdmin() / requireSuperAdmin()  ← selalu cek sesi di SERVER
                     ├─ lib/auth ──────────► platformClient()  (login DB ws_platform_app, lintas tenant)
                     ├─ lib/dal/tenant ────► withTenant(id)    (login DB ws_tenant_app, RLS per sekolah)
                     └─ lib/dal/platform ──► platformClient()  + assertCan(RBAC)
                                   │ VPC (direct egress, private IP, TLS wajib)
                              Cloud SQL PostgreSQL 16 (HA, PITR, backup 30 hari)
Secret Manager ──► env Cloud Run (APP_SECRET, TOTP_ENC_KEY, URL DB, Google client)
GCS (privat, versioning) ──► media (Fase 2; URL bertanda tangan ≤10 menit)
```

## Dua login database (defence in depth)
| Login | Peran | Akses |
|---|---|---|
| `ws_migrator` | pemilik skema | hanya `prisma migrate deploy` (Cloud Run Job); tidak pernah dipakai aplikasi |
| `ws_tenant_app` | `ws_tenant_role` | hanya baris dengan `tenant_id = app.tenant_id`; **tidak** dapat membaca `password_hash`, `totp_secret_enc`, `auth_subject`, sesi, reset, rate limit; tagihan read-only; domain hanya bisa *diajukan* |
| `ws_platform_app` | `ws_platform_role` | lintas tenant; hanya boleh diimpor oleh `lib/auth`, `lib/dal`, `lib/audit` (ESLint menegakkan); `audit_logs`/`payments` hanya INSERT/SELECT |
| `ws_definer` | pemilik fungsi | memiliki `resolve_host()`; kolom terbatas |

`withTenant(id, fn)` membuka transaksi lalu `set_config('app.tenant_id', id, true)` (lokal-transaksi, tidak bocor antar request di pool). Tanpa konteks → **nol baris** (fail closed). ID tenant hanya berasal dari sesi terautentikasi atau hasil resolusi host — tidak pernah dari input pengguna.

## Alur permintaan
1. **Login**: Google (state+PKCE → `resolveGoogleLogin`) atau email+sandi (`passwordLogin`) → sesi server-side (token acak 256-bit di cookie `__Host-ws_session`, hanya SHA-256-nya di DB). Super Admin wajib TOTP; tanpa MFA terverifikasi ia hanya punya `public.read`.
2. **Halaman CMS**: `requireSchoolAdmin()` → `principalOf()` → DAL memanggil `withTenant(tenantId dari sesi)`.
3. **Konsol Super**: `requireSuperAdmin()` → DAL platform memanggil `assertCan(principal, 'tenant.manage')` sebelum query.
4. **Host publik (Fase 3)**: `normalizeHostname()` → `resolve_host()` (SECURITY DEFINER) → tenant → `withTenant()`. Host tak dikenal ⇒ 404, tidak ada tenant default.

## Roadmap (menyusul Fase 2)
- **Fase 2** — Inti CMS: provisioning tenant & undangan (email), modul konten dengan pola draft/publish, media upload aman (URL bertanda tangan, validasi signature, kuota atomik, pemindaian), audit untuk semua mutasi, konflik versi 409.
- **Fase 3** — Situs publik (render server + cache per tenant/bahasa), 10 tema (port dari prototipe), halaman blok, navigasi, SEO/sitemap, dua bahasa, analytics agregat, GA dengan persetujuan.
- **Fase 4** — Operasional: billing manual + scheduler langganan, domain/TLS (HTTPS LB + Certificate Manager), feature flag, impersonation (sesi 15 menit), worker job/outbox, monitoring & alarm, backup-restore drill, load test (NFR01), pentest.

## Fase 2: lapisan layanan
```
UI (server components/actions, client editor) ─▶ services/* ─▶ withTenant()/platformClient() ─▶ PostgreSQL (RLS)
                                                    │
                                   audit + jobs (outbox) di TRANSAKSI yang sama
```
- **Services** (`src/lib/services/{content,media,provisioning,settings}.ts`) adalah satu-satunya tempat aturan bisnis. Mereka menerima `Actor` (dibangun dari sesi oleh `actorOf()`), tidak pernah id tenant/pengguna dari input. UI tidak boleh mengimpor klien DB (ESLint).
- **Antrean pekerjaan** (`src/lib/jobs.ts`): tabel `jobs`, `FOR UPDATE SKIP LOCKED`, maks. 5 percobaan dengan backoff, lalu `DEAD`; `dedupe_key` unik; rahasia (token undangan/reset) disegel AES-GCM dan dihapus saat `DONE`. Dijalankan oleh Cloud Scheduler tiap menit ke `/api/internal/jobs/run`.
- **Media**: `ObjectStore` (GCS / lokal). Bucket privat; byte hanya keluar lewat aplikasi setelah cek akses (pratinjau CMS). Pengiriman publik ke pengunjung dibangun bersama situs publik (Fase 3).
- **Konflik versi**: setiap `UPDATE ... WHERE version = ?`; 0 baris ⇒ `ConflictError` ⇒ HTTP 409 / banner “Muat ulang versi terbaru” di editor.
- **Idempotensi**: tabel `idempotency_keys` (khusus platform); pembuatan tenant yang gagal tidak meninggalkan sisa dan kunci yang sama dapat diulang.
