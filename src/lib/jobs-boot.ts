import { registerHandler } from "@/lib/jobs";
import { registerMailHandlers } from "@/lib/mail/handlers";
import { cleanupExpiredUploads } from "@/lib/services/media";

/** Registers every job handler. Called by the internal runner route (and by tests). */
let booted = false;
export function bootJobs() {
  if (booted) return; booted = true;
  registerMailHandlers();
  // Phase 3 replaces this with real CDN/page-cache invalidation; until then publishing is visible immediately because nothing is cached.
  registerHandler("cache.invalidate", async () => undefined);
  registerHandler("media.cleanup", async () => { await cleanupExpiredUploads(); });
}
