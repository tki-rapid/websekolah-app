import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Object storage behind one interface. Production = private GCS bucket (V4 signed URLs, service-account signing, no key files).
 * Dev/test = local directory with an HMAC-signed upload URL handled by /api/media/upload/[id].
 * The bucket is NEVER public: bytes reach browsers only through the app, after an access check.
 */
export type UploadTicket = { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: Date };
export interface ObjectStore {
  createUploadUrl(key: string, o: { contentType: string; maxBytes: number; expiresInSec: number }): Promise<UploadTicket>;
  head(key: string): Promise<{ size: number } | null>;
  readRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  read(key: string): Promise<Buffer>;
  write(key: string, data: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const safeKey = (key: string) => {
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) || key.includes("..")) throw new Error("invalid object key");
  return key;
};

export class LocalObjectStore implements ObjectStore {
  constructor(private dir: string, private secretB64: string, private appUrl: string) {}
  private p = (key: string) => path.join(path.resolve(this.dir), safeKey(key));
  sign(key: string, exp: number, contentType: string, maxBytes: number) {
    return createHmac("sha256", Buffer.from(this.secretB64, "base64")).update(`${key}|${exp}|${contentType}|${maxBytes}`).digest("base64url");
  }
  verify(key: string, exp: number, contentType: string, maxBytes: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const a = Buffer.from(this.sign(key, exp, contentType, maxBytes)), b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async createUploadUrl(key: string, o: { contentType: string; maxBytes: number; expiresInSec: number }): Promise<UploadTicket> {
    safeKey(key);
    const exp = Math.floor(Date.now() / 1000) + o.expiresInSec;
    const url = new URL(`/api/media/upload/${encodeURIComponent(key)}`, this.appUrl);
    url.searchParams.set("exp", String(exp)); url.searchParams.set("ct", o.contentType); url.searchParams.set("max", String(o.maxBytes));
    url.searchParams.set("sig", this.sign(key, exp, o.contentType, o.maxBytes));
    return { url: url.toString(), method: "PUT", headers: { "Content-Type": o.contentType }, expiresAt: new Date(exp * 1000) };
  }
  async head(key: string) { try { return { size: (await stat(this.p(key))).size }; } catch { return null; } }
  async readRange(key: string, start: number, end: number) { return (await readFile(this.p(key))).subarray(start, end + 1); }
  async read(key: string) { return readFile(this.p(key)); }
  async write(key: string, data: Buffer, _contentType?: string) { const f = this.p(key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, data); }
  async remove(key: string) { await rm(this.p(key), { force: true }); }
}

export class GcsObjectStore implements ObjectStore {
  private bucketPromise?: Promise<import("@google-cloud/storage").Bucket>;
  constructor(private bucketName: string) {}
  private bucket() {
    return (this.bucketPromise ??= import("@google-cloud/storage").then(({ Storage }) => new Storage().bucket(this.bucketName)));
  }
  async createUploadUrl(key: string, o: { contentType: string; maxBytes: number; expiresInSec: number }): Promise<UploadTicket> {
    safeKey(key);
    const expiresAt = new Date(Date.now() + o.expiresInSec * 1000);
    // Signed with the runtime service account via IAM Credentials (needs roles/iam.serviceAccountTokenCreator on itself).
    const [url] = (await this.bucket()).file(key).getSignedUrl({
      version: "v4", action: "write", expires: expiresAt, contentType: o.contentType,
      extensionHeaders: { "x-goog-content-length-range": `1,${o.maxBytes}` }, // GCS rejects bigger bodies
    }) as unknown as [string];
    return { url, method: "PUT", headers: { "Content-Type": o.contentType, "x-goog-content-length-range": `1,${o.maxBytes}` }, expiresAt };
  }
  async head(key: string) {
    const [exists] = await (await this.bucket()).file(key).exists(); if (!exists) return null;
    const [m] = await (await this.bucket()).file(key).getMetadata(); return { size: Number(m.size) };
  }
  async readRange(key: string, start: number, end: number) {
    const chunks: Buffer[] = [];
    for await (const c of (await this.bucket()).file(key).createReadStream({ start, end })) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  async read(key: string) { return (await (await this.bucket()).file(key).download())[0]; }
  async write(key: string, data: Buffer, contentType: string) { await (await this.bucket()).file(key).save(data, { contentType, resumable: false }); }
  async remove(key: string) { await (await this.bucket()).file(key).delete({ ignoreNotFound: true }); }
}

let store: ObjectStore | undefined;
export function getStore(): ObjectStore {
  if (store) return store;
  const e = env();
  store = e.MEDIA_BACKEND === "gcs" ? new GcsObjectStore(e.MEDIA_BUCKET!) : new LocalObjectStore(e.MEDIA_LOCAL_DIR, e.APP_SECRET, e.APP_URL);
  return store;
}
export const setStoreForTests = (s: ObjectStore | undefined) => { store = s; };
