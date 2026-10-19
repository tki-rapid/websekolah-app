export type UploadedMedia = { id: string; name: string; mime: string };

async function readError(r: Response, fallback: string): Promise<string> {
  try { const j = (await r.json()) as { message?: string }; return j.message ?? fallback; } catch { return fallback; }
}

/** presign → PUT bytes straight to storage → finalize (server verifies, scans, re-encodes). */
export async function uploadFile(file: File, onStep?: (s: string) => void): Promise<UploadedMedia> {
  onStep?.("Menyiapkan…");
  const p = await fetch("/api/media/presign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, mime: file.type, bytes: file.size }) });
  if (!p.ok) throw new Error(await readError(p, "Gagal menyiapkan unggahan"));
  const { assetId, upload } = (await p.json()) as { assetId: string; upload: { url: string; method: string; headers: Record<string, string> } };
  onStep?.("Mengunggah…");
  const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
  if (!put.ok) throw new Error("Unggahan ditolak oleh penyimpanan");
  onStep?.("Memeriksa berkas…");
  const f = await fetch(`/api/media/${assetId}/finalize`, { method: "POST" });
  if (!f.ok) throw new Error(await readError(f, "Berkas tidak lolos pemeriksaan"));
  return (await f.json()) as UploadedMedia;
}
