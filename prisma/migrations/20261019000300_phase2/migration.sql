-- Phase 2: idempotency keys (provisioning retries), media upload lifecycle columns, helper indexes.

CREATE TABLE "idempotency_keys" (
  "key"        TEXT NOT NULL,
  "scope"      TEXT NOT NULL,
  "actor_id"   UUID,
  "result"     JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key", "scope")
);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON idempotency_keys FOR ALL TO ws_platform_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO ws_platform_role;

ALTER TABLE "media_assets"
  ADD COLUMN "thumb_key"         TEXT,
  ADD COLUMN "width"             INTEGER,
  ADD COLUMN "height"            INTEGER,
  ADD COLUMN "upload_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "original_name"     TEXT;
-- a PENDING reservation always has a deadline (PRD §13.1: signed URL <= 10 min, cleanup of pending after 24h)
ALTER TABLE media_assets ADD CONSTRAINT media_assets_pending_deadline CHECK (state <> 'PENDING' OR upload_expires_at IS NOT NULL);
CREATE INDEX media_assets_pending_idx ON media_assets (upload_expires_at) WHERE state = 'PENDING';

-- content ordering / listing helpers
CREATE INDEX content_items_list_idx ON content_items (tenant_id, type, updated_at DESC) WHERE deleted_at IS NULL;
