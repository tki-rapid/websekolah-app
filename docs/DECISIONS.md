# Catatan keputusan arsitektur

**1. Sesi server-side sendiri (arctic + tabel `sessions`) alih-alih Auth.js.**
PRD mewajibkan sesi yang *dicabut seketika* (ganti admin, reset sandi) dan login email+sandi *bersama* Google. Auth.js v5 masih beta dan
penyedia Credentials tidak mendukung sesi database; JWT stateless tidak bisa dicabut tanpa pencarian DB. `arctic` hanya menangani OAuth/OIDC
(Google) dan semua logika sesi ada di `lib/auth/session.ts` (± 100 baris) yang diuji. Kompromi: kita memiliki kode sesi ini — karena itu ada 30 tes auth.

**2. RLS berbasis `app.tenant_id` (set per transaksi) + dua login DB.**
Jika memakai satu login, bug aplikasi yang memanggil jalur lintas-tenant bisa membocorkan data. Dengan dua login, kode tenant secara fisik tidak punya hak
membaca kolom rahasia atau tabel sesi, dan hanya `lib/auth|dal|audit` yang boleh memakai login platform (ESLint). Risiko sisa: kode yang menjalankan
`set_config` dengan ID lain di login tenant — dibatasi karena hanya `withTenant()` yang melakukannya dan ID berasal dari sesi.

**3. Migrasi SQL tulisan tangan untuk lapisan keamanan.** Prisma tidak dapat mengekspresikan RLS, trigger, partial index, grant. `prisma migrate deploy` tetap
dipakai untuk menerapkannya. Jangan memakai `migrate dev` yang akan mencoba menghapus objek yang tak dikenalnya; buat migrasi dengan `--create-only` lalu tinjau.

**4. Prisma 7 + `@prisma/adapter-pg`.** Rekomendasi PRD; adapter memberi kontrol penuh atas koneksi (`options: -c timezone=UTC`).

**5. Next.js `proxy.ts` hanya untuk header & validasi Host, bukan otorisasi.** Otorisasi diulang di setiap halaman/aksi/route (praktik data-security Next.js).

**6. Cloud Run + Cloud SQL privat + Secret Manager.** Operasional ringan untuk tim kecil, skala otomatis, TLS terkelola. Custom domain per sekolah (Fase 4) memerlukan HTTPS Load Balancer + Certificate Manager.

**7. Semua waktu UTC.** Sesi DB dipaksa `timezone=UTC` (bug zona waktu tertangkap tes).

**8. Password minimal 12 karakter** (NIST 800-63B: panjang > komposisi). PRD tidak menetapkan angka; ubah di `passwordPolicyError`.

## Fase 2
- **Antrean di PostgreSQL, bukan Pub/Sub/Cloud Tasks**: satu sumber kebenaran, ditulis di transaksi yang sama dengan perubahan (outbox), tanpa dependensi baru. Skala MVP (~100 sekolah) jauh di bawah batasnya; antarmuka `enqueue/registerHandler` memudahkan pindah nanti.
- **Konten sebagai JSON tervalidasi dari registri skema**, bukan tabel per modul: satu definisi menghasilkan form, validator server, dan aturan terjemahan; kolom `version` + `draft_payload`/`published_payload` memberi draft/terbit dan konflik versi secara seragam.
- **Rich text = Markdown subset** yang di-escape saat render: tidak ada sanitizer HTML yang bisa dilewati.
- **Pratinjau media lewat aplikasi** (bukan URL publik): bucket tetap privat; pengiriman publik menyusul dengan situs publik (Fase 3) lewat jalur terautentikasi-tenant/cached.
- **Pengaturan sekolah tanpa kunci versi**: satu admin per sekolah dan field sedikit; last-write-wins dengan audit. Konten memakai 409.
- **Gating fitur per paket (galeri/PPDB)** belum diterapkan di UI CMS; kolom `features` paket sudah ada dan akan dipakai bersama penagihan (Fase 4).
