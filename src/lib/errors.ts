/** Typed failures that services throw and the UI layer maps to messages/HTTP codes. */
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 400) { super(message); }
}
export class NotFoundError extends AppError { constructor(what = "Data") { super(`${what} tidak ditemukan`, "not_found", 404); } }
/** 409 — someone else saved first (optimistic locking, PRD §7). Carries the current version so the UI can reload. */
export class ConflictError extends AppError { constructor(public readonly currentVersion: number, message = "Data telah diubah di tab/sesi lain. Muat ulang untuk melihat versi terbaru.") { super(message, "conflict", 409); } }
export class ValidationError extends AppError { constructor(public readonly fields: Record<string, string>, message = "Periksa kembali isian Anda") { super(message, "validation", 422); } }
export class ReauthRequiredError extends AppError { constructor() { super("Aksi sensitif: konfirmasi ulang identitas Anda (maks. 10 menit sebelumnya)", "reauth_required", 401); } }
export class QuotaExceededError extends AppError { constructor(message = "Kuota penyimpanan paket Anda tidak mencukupi") { super(message, "quota_exceeded", 413); } }
export class TenantUnavailableError extends AppError { constructor() { super("Layanan sekolah ini ditangguhkan atau tidak aktif; perubahan tidak diizinkan", "tenant_unavailable", 403); } }
export class UploadRejectedError extends AppError { constructor(message: string) { super(message, "upload_rejected", 422); } }
