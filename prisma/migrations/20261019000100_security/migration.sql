-- ═══════════════════════════════════════════════════════════════════════════
-- Security layer (PRD §10, §12, §13): constraints Prisma cannot express, tenant isolation via
-- Row Level Security, immutability triggers, least-privilege grants, narrow definer lookups.
-- Requires roles from scripts/db-bootstrap.sql (ws_tenant_role, ws_platform_role, ws_definer).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── helper: current tenant from the transaction-local setting (fails CLOSED when unset) ──
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ══════════════ 1. data-integrity constraints ══════════════
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  ADD CONSTRAINT tenants_slug_reserved CHECK (slug NOT IN
    ('admin','api','www','cms','super','login','app','mail','static','assets','cdn','media','ftp','status',
     'support','ns1','ns2','smtp','imap','pop','webmail','dashboard','auth','internal','health')),
  ADD CONSTRAINT tenants_lang_valid CHECK (default_lang IN ('id','en') AND (default_lang = 'id' OR enable_en)),
  ADD CONSTRAINT tenants_ga_id_format CHECK (ga_measurement_id IS NULL OR ga_measurement_id ~ '^G-[A-Z0-9]{6,12}$'),
  ADD CONSTRAINT tenants_ga_needs_id CHECK (NOT ga_enabled OR ga_measurement_id IS NOT NULL);

ALTER TABLE users
  ADD CONSTRAINT users_email_lower CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT users_role_tenant CHECK (
    (role = 'SUPER_ADMIN' AND tenant_id IS NULL) OR (role = 'SCHOOL_ADMIN' AND tenant_id IS NOT NULL));
-- TEN02: exactly one ACTIVE admin per school, guaranteed by the database
CREATE UNIQUE INDEX users_one_active_admin_per_tenant ON users (tenant_id)
  WHERE role = 'SCHOOL_ADMIN' AND active;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_email_lower CHECK (email = lower(email)),
  ADD CONSTRAINT invitations_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days');

ALTER TABLE domains
  ADD CONSTRAINT domains_hostname_normalized CHECK (
    hostname = lower(hostname)
    AND hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    AND length(hostname) <= 253);
CREATE UNIQUE INDEX domains_one_active_primary ON domains (tenant_id) WHERE "primary" AND status = 'ACTIVE';

ALTER TABLE plan_versions
  ADD CONSTRAINT plan_versions_amount CHECK (amount >= 0 AND currency = 'IDR');
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_period CHECK (period_end > period_start);
ALTER TABLE invoices
  ADD CONSTRAINT invoices_amount CHECK (amount >= 0 AND currency = 'IDR'),
  ADD CONSTRAINT invoices_period CHECK (period_end > period_start);
ALTER TABLE payments
  ADD CONSTRAINT payments_amount CHECK (amount >= 0);

ALTER TABLE feature_flags
  ADD CONSTRAINT feature_flags_scope CHECK (
    (scope = 'GLOBAL' AND tenant_id IS NULL) OR (scope = 'TENANT' AND tenant_id IS NOT NULL));
CREATE UNIQUE INDEX feature_flags_global_key ON feature_flags (key) WHERE scope = 'GLOBAL';
CREATE UNIQUE INDEX feature_flags_tenant_key ON feature_flags (key, tenant_id) WHERE scope = 'TENANT';

-- CMS15 / §13.1: allowed media types and size caps; object keys are tenant-prefixed
ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_mime CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  ADD CONSTRAINT media_assets_size CHECK (
    bytes > 0 AND ((mime = 'application/pdf' AND bytes <= 20971520) OR (mime <> 'application/pdf' AND bytes <= 5242880))),
  ADD CONSTRAINT media_assets_key_prefix CHECK (object_key LIKE tenant_id::text || '/%');

ALTER TABLE content_items
  ADD CONSTRAINT content_items_slug CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80);
ALTER TABLE pages
  ADD CONSTRAINT pages_slug CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  ADD CONSTRAINT pages_slug_reserved CHECK (is_home OR slug NOT IN
    ('beranda','p','berita','pengumuman','agenda','download','guru','fasilitas','prestasi','galeri','ppdb','kontak',
     'profil','id','en','admin','api','cms','sitemap.xml','robots.txt')),
  -- AC05: at most 20 blocks per page
  ADD CONSTRAINT pages_block_limit CHECK (
    jsonb_typeof(draft_blocks) = 'array' AND jsonb_array_length(draft_blocks) <= 20
    AND (published_blocks IS NULL OR (jsonb_typeof(published_blocks) = 'array' AND jsonb_array_length(published_blocks) <= 20)));
CREATE UNIQUE INDEX pages_one_home ON pages (tenant_id) WHERE is_home;

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_target CHECK (
    (type = 'PAGE'   AND target_page_id IS NOT NULL AND url IS NULL AND system_target IS NULL) OR
    (type = 'SYSTEM' AND system_target IS NOT NULL AND url IS NULL AND target_page_id IS NULL) OR
    (type = 'URL'    AND url ~ '^https://[^\s]+$' AND target_page_id IS NULL AND system_target IS NULL));
ALTER TABLE analytics_daily ADD CONSTRAINT analytics_views CHECK (views >= 0);
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts CHECK (attempts BETWEEN 0 AND 5);
ALTER TABLE impersonation_sessions ADD CONSTRAINT imp_max_15_min CHECK (expires_at <= created_at + interval '15 minutes');

-- ══════════════ 2. triggers: immutability & integrity ══════════════
-- tenant_id can never be moved to another school
CREATE FUNCTION forbid_tenant_id_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable on %', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','invitations','content_items','pages','menu_items','media_assets','media_references',
    'tenant_themes','domains','subscriptions','invoices','payments','analytics_daily','impersonation_sessions','feature_flags']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_tenant_id_change()', t || '_tenant_immutable', t);
  END LOOP;
END $$;

-- append-only tables (ADM07): audit_logs, payments
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- versions are immutable so old invoices keep their price (ADM03); theme versions only toggle `active`
CREATE FUNCTION forbid_plan_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan_versions are immutable; create a new version' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION forbid_plan_version_change();
CREATE FUNCTION theme_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'theme_versions cannot be deleted' USING ERRCODE = '42501'; END IF;
  IF (NEW.schema, NEW.allowed_variants, NEW.version, NEW.theme_id) IS DISTINCT FROM (OLD.schema, OLD.allowed_variants, OLD.version, OLD.theme_id) THEN
    RAISE EXCEPTION 'theme_versions are immutable except active' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER theme_versions_guard BEFORE UPDATE OR DELETE ON theme_versions FOR EACH ROW EXECUTE FUNCTION theme_version_guard();

-- invoice state machine: DRAFT -> ISSUED -> PAID | VOID; PAID/VOID are final; PAID requires its payment
CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'only DRAFT invoices can be deleted' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('PAID','VOID') THEN
    RAISE EXCEPTION 'invoice % is final (%); void and re-issue instead', OLD.number, OLD.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.amount, NEW.number, NEW.plan_name, NEW."interval", NEW.period_start, NEW.period_end)
       IS DISTINCT FROM (OLD.amount, OLD.number, OLD.plan_name, OLD."interval", OLD.period_start, OLD.period_end) THEN
    RAISE EXCEPTION 'issued invoice fields are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'PAID' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'cannot mark invoice PAID without a payment record' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT','ISSUED','VOID') THEN
    RAISE EXCEPTION 'invalid invoice transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_guard();

-- a payment must match its invoice (tenant + amount) and an ISSUED invoice (idempotent single payment: UNIQUE(invoice_id))
CREATE FUNCTION payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv invoices%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF inv.id IS NULL OR inv.tenant_id <> NEW.tenant_id THEN RAISE EXCEPTION 'payment/invoice tenant mismatch' USING ERRCODE = '23514'; END IF;
  IF inv.status <> 'ISSUED' THEN RAISE EXCEPTION 'invoice is not ISSUED' USING ERRCODE = '23514'; END IF;
  IF inv.amount <> NEW.amount THEN RAISE EXCEPTION 'payment amount must equal invoice amount' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payment_guard();

-- navigation depth <= 3 (CMS14)
CREATE FUNCTION menu_depth_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d int := 1; cur uuid := NEW.parent_id; guard int := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    d := d + 1; guard := guard + 1;
    IF cur = NEW.id OR guard > 10 THEN RAISE EXCEPTION 'menu cycle' USING ERRCODE = '23514'; END IF;
    SELECT parent_id INTO cur FROM menu_items WHERE id = cur AND tenant_id = NEW.tenant_id;
  END LOOP;
  IF d > 3 THEN RAISE EXCEPTION 'navigation depth limited to 3 levels' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER menu_items_depth BEFORE INSERT OR UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION menu_depth_guard();

-- identity columns that must never change after creation
CREATE FUNCTION user_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN RAISE EXCEPTION 'user role is immutable' USING ERRCODE = '42501'; END IF;
  IF OLD.auth_subject IS NOT NULL AND NEW.auth_subject IS DISTINCT FROM OLD.auth_subject THEN
    RAISE EXCEPTION 'linked Google subject cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_identity_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION user_identity_guard();

-- ══════════════ 3. Row Level Security ══════════════
-- Tenant-scoped tables: the tenant role sees/writes only rows whose tenant_id equals the
-- transaction-local app.tenant_id (set by withTenant()). Unset => no rows (fail closed).
-- Platform role: cross-tenant, used only by the audited platform/auth/worker modules.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['content_items','pages','menu_items','media_assets','media_references','tenant_themes',
    'domains','subscriptions','invoices','payments','analytics_daily','invitations','impersonation_sessions','jobs','outbox','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_all ON %I FOR ALL TO ws_platform_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- Tenant role policies (explicit per table so the verbs granted below match what RLS allows)
CREATE POLICY tenant_rw ON content_items FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON pages FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON menu_items FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON media_assets FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON media_references FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON tenant_themes FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_rw ON analytics_daily FOR ALL TO ws_tenant_role USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_read ON subscriptions FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_read ON invoices FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_read ON payments FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_read ON invitations FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_read ON impersonation_sessions FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
-- a school may only REQUEST a custom domain; activation/verification is operator-only (ADM04)
CREATE POLICY tenant_read ON domains FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_request ON domains FOR INSERT TO ws_tenant_role
  WITH CHECK (tenant_id = app_current_tenant() AND status = 'REQUESTED' AND kind = 'CUSTOM' AND NOT "primary");
CREATE POLICY tenant_enqueue ON jobs FOR INSERT TO ws_tenant_role WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_enqueue ON outbox FOR INSERT TO ws_tenant_role WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_audit_read ON audit_logs FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_audit_write ON audit_logs FOR INSERT TO ws_tenant_role WITH CHECK (tenant_id = app_current_tenant());

-- tenants / users / feature_flags have extra shapes
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON tenants FOR ALL TO ws_platform_role USING (true) WITH CHECK (true);
CREATE POLICY tenant_self ON tenants FOR SELECT TO ws_tenant_role USING (id = app_current_tenant());
CREATE POLICY tenant_self_update ON tenants FOR UPDATE TO ws_tenant_role USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON users FOR ALL TO ws_platform_role USING (true) WITH CHECK (true);
CREATE POLICY tenant_users_read ON users FOR SELECT TO ws_tenant_role USING (tenant_id = app_current_tenant());

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY; ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON feature_flags FOR ALL TO ws_platform_role USING (true) WITH CHECK (true);
CREATE POLICY tenant_flags_read ON feature_flags FOR SELECT TO ws_tenant_role USING (scope = 'GLOBAL' OR tenant_id = app_current_tenant());

-- platform-only tables: RLS on with a platform policy only => the tenant role can read/write NOTHING
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','password_resets','rate_limits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_all ON %I FOR ALL TO ws_platform_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- definer role may read domains/tenants for host resolution only
CREATE POLICY definer_read ON domains FOR SELECT TO ws_definer USING (true);
CREATE POLICY definer_read ON tenants FOR SELECT TO ws_definer USING (true);

-- ══════════════ 4. least-privilege grants ══════════════
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ws_tenant_role, ws_platform_role, ws_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- tenant role
GRANT SELECT ON tenants TO ws_tenant_role;
GRANT UPDATE (enable_en, default_lang, show_lang_switcher, ga_enabled, ga_measurement_id, ga_require_consent, ga_skip_admins, updated_at)
  ON tenants TO ws_tenant_role;
-- never expose password_hash / totp_secret_enc / auth_subject to tenant-scoped code
GRANT SELECT (id, tenant_id, email, name, role, active, totp_enabled, last_login_at, created_at, version) ON users TO ws_tenant_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_items, pages, menu_items, media_assets, media_references, analytics_daily TO ws_tenant_role;
GRANT SELECT, UPDATE (theme_version_id, tokens, layout, previous_config, updated_at) ON tenant_themes TO ws_tenant_role;
GRANT SELECT ON subscriptions, invoices, payments, invitations, impersonation_sessions, domains, feature_flags TO ws_tenant_role;
GRANT INSERT ON domains, jobs, outbox TO ws_tenant_role;
GRANT SELECT, INSERT ON audit_logs TO ws_tenant_role;
GRANT SELECT ON themes, theme_versions, plans, plan_versions TO ws_tenant_role;

-- platform role: everything operationally needed; audit_logs is insert/select only
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, sessions, invitations, password_resets, rate_limits, impersonation_sessions,
  themes, theme_versions, plans, plan_versions, feature_flags, content_items, pages, menu_items, media_assets,
  media_references, tenant_themes, domains, subscriptions, invoices, analytics_daily, jobs, outbox TO ws_platform_role;
GRANT SELECT, INSERT ON payments, audit_logs TO ws_platform_role;

-- ══════════════ 5. narrow SECURITY DEFINER lookups ══════════════
-- Public request routing: hostname -> tenant. The ONLY cross-tenant read reachable from tenant-scoped code.
-- Returns nothing for unknown, non-active or soft-deleted hosts (never falls back to another tenant).
GRANT SELECT (id, slug, status, deleted_at) ON tenants TO ws_definer;
GRANT SELECT (tenant_id, hostname, "primary", status, kind) ON domains TO ws_definer;
CREATE FUNCTION resolve_host(p_host text)
RETURNS TABLE (tenant_id uuid, slug text, tenant_status "TenantStatus", is_primary boolean, kind "DomainKind")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT d.tenant_id, t.slug, t.status, d."primary", d.kind
    FROM domains d JOIN tenants t ON t.id = d.tenant_id
   WHERE d.hostname = lower(p_host) AND d.status = 'ACTIVE' AND t.deleted_at IS NULL
   LIMIT 1
$$;
-- ownership transfer needs CREATE on the schema; grant it only for this statement
GRANT CREATE ON SCHEMA public TO ws_definer;
ALTER FUNCTION resolve_host(text) OWNER TO ws_definer;
REVOKE CREATE ON SCHEMA public FROM ws_definer;
GRANT EXECUTE ON FUNCTION resolve_host(text) TO ws_tenant_role, ws_platform_role;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO ws_tenant_role, ws_platform_role, ws_definer;
