# Menyiapkan & men-deploy ke Google Cloud Platform

Prasyarat: proyek GCP dengan billing, `gcloud` terautentikasi, OpenTofu/Terraform ≥ 1.6, domain untuk aplikasi (mis. `app.websekolah.id`).

## 1. Provisioning infrastruktur (dua tahap, karena image harus ada sebelum Cloud Run dibuat)
```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # isi project_id & app_url
# disarankan: aktifkan backend gcs di versions.tf (state berisi rahasia hasil generate)
terraform init
terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.repo   # tahap 1: API + registry
# bangun & push image awal (tag "bootstrap"; migrate/deploy di pipeline ini akan gagal wajar karena job belum ada → gunakan langkah build saja):
cd ../.. && gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=asia-southeast2 --no-source=false || true
cd infra/terraform && terraform apply                                                              # tahap 2: sisanya
```
Membuat: VPC + Cloud SQL PostgreSQL 16 **privat** (HA, PITR), Secret Manager (rahasia ter-generate), service account hak minimal, bucket media privat,
Cloud Run service + dua Cloud Run Job (`websekolah-db-bootstrap`, `websekolah-migrate`).

## 2. Login dengan Google
1. Console → APIs & Services → **OAuth consent screen** (External/Internal) → lalu **Credentials → Create OAuth client ID → Web application**.
2. *Authorized redirect URI*: `<APP_URL>/api/auth/google/callback` (output Terraform `google_oauth_redirect_uri`).
3. Simpan nilainya:
```bash
printf '%s' "$CLIENT_ID"     | gcloud secrets versions add google-client-id --data-file=-
printf '%s' "$CLIENT_SECRET" | gcloud secrets versions add google-client-secret --data-file=-
```
Hanya pengguna yang **sudah dibuat** oleh operator (dan `email_verified` di Google) yang bisa masuk — tidak ada registrasi mandiri.

## 3. Inisialisasi database lalu deploy
```bash
gcloud run jobs execute websekolah-db-bootstrap --region asia-southeast2 --wait   # SEKALI: membuat peran DB hak-minimal
gcloud run jobs execute websekolah-migrate --region asia-southeast2 --wait        # skema + RLS
```
Urutan: **bootstrap → migrate → deploy**. Setelah itu, buat trigger Cloud Build pada repo Anda dengan `_TAG=$SHORT_SHA`; pipeline menjalankan migrate otomatis sebelum setiap deploy.

## 4. Super Admin pertama
Jalankan seed sekali sebagai Cloud Run Job (atau dari mesin Anda lewat Cloud SQL Auth Proxy) dengan `SEED_SUPERADMIN_EMAIL=<email Google Anda>`.
Tanpa kata sandi: masuk memakai Google, lalu **MFA TOTP wajib didaftarkan** pada login pertama.

## 5. Pasca-deploy
- Verifikasi `GET /api/health` = `{"status":"ok"}` dan header keamanan (`curl -I`).
- Domain aplikasi: Cloud Run → *Manage custom domains* (atau Load Balancer pada Fase 4). Pastikan `APP_URL` sama persis dengan origin publik.
- Cloud Run di belakang LB Google ⇒ set `TRUSTED_PROXY_HOPS=2` agar IP klien (rate limit/audit) benar.
- Alarm: 5xx, latensi p95, CPU/koneksi Cloud SQL, uptime check `/api/health`.
- Lihat daftar periksa go-live di `SECURITY.md`.

## 6. Email, pekerja, dan media (Fase 2)
1. **SMTP**: isi rahasia `smtp-url` (mis. `smtps://USER:PASS@smtp.penyedia.com:465`) — `gcloud secrets versions add smtp-url --data-file=-`. Tanpa ini aplikasi produksi menolak start (undangan & reset sandi dikirim lewat email). Pastikan domain pengirim (`MAIL_FROM`) memiliki SPF/DKIM.
2. **Pekerja**: Terraform membuat Cloud Scheduler `websekolah-jobs` (tiap menit → `POST /api/internal/jobs/run` dengan `Authorization: Bearer <job-runner-token>`). Periksa lewat Cloud Scheduler → *Force run*; respons `{"jobs":{"done":…}}`.
3. **Media**: bucket privat dibuat Terraform dengan CORS (hanya origin aplikasi, `PUT`). Service account aplikasi memerlukan `roles/iam.serviceAccountTokenCreator` pada dirinya sendiri (sudah diatur) agar dapat menandatangani URL V4 tanpa file kunci.
4. Uji: unggah gambar di CMS → harus muncul di Pustaka media; kirim undangan dari konsol Super Admin → email tiba dalam ≤ 1–2 menit.
