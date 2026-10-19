-- One-time, idempotent role bootstrap. Run as a database ADMIN (postgres / cloudsqlsuperuser),
-- never from the application. Passwords are passed in as psql variables:
--   psql -v mig_pw=... -v tenant_pw=... -v platform_pw=... -f scripts/db-bootstrap.sql <admin-conn>
--
-- Role model (defence in depth, PRD §12):
--   ws_migrator     owns the schema, runs `prisma migrate deploy`. Not used at runtime.
--   ws_tenant_app   runtime login for tenant-scoped requests  -> member of ws_tenant_role  (RLS by tenant)
--   ws_platform_app runtime login for platform/auth/worker    -> member of ws_platform_role (cross-tenant, audited)
--   ws_definer      NOLOGIN owner of the narrow SECURITY DEFINER lookups (e.g. resolve_host)
-- None of them is SUPERUSER or BYPASSRLS.

SELECT format('CREATE ROLE ws_migrator LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'mig_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_migrator') \gexec
SELECT 'CREATE ROLE ws_tenant_role NOLOGIN NOSUPERUSER NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_tenant_role') \gexec
SELECT 'CREATE ROLE ws_platform_role NOLOGIN NOSUPERUSER NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_platform_role') \gexec
SELECT 'CREATE ROLE ws_definer NOLOGIN NOSUPERUSER NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_definer') \gexec
SELECT format('CREATE ROLE ws_tenant_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS IN ROLE ws_tenant_role', :'tenant_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_tenant_app') \gexec
SELECT format('CREATE ROLE ws_platform_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS IN ROLE ws_platform_role', :'platform_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_platform_app') \gexec

-- Always reconcile login passwords from Secret Manager. This makes a retry safe if an
-- earlier bootstrap created roles but failed before completing the script.
SELECT format('ALTER ROLE ws_migrator PASSWORD %L', :'mig_pw') \gexec
SELECT format('ALTER ROLE ws_tenant_app PASSWORD %L', :'tenant_pw') \gexec
SELECT format('ALTER ROLE ws_platform_app PASSWORD %L', :'platform_pw') \gexec

-- The current database admin must be a member of the target owner role before
-- PostgreSQL permits ALTER DATABASE ... OWNER TO ws_migrator.
GRANT ws_migrator TO CURRENT_USER;

-- The migrator must be able to assign function ownership to ws_definer.
GRANT ws_definer TO ws_migrator;

SELECT format('ALTER DATABASE %I OWNER TO ws_migrator', current_database()) \gexec
ALTER SCHEMA public OWNER TO ws_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ws_tenant_role, ws_platform_role, ws_definer;
GRANT CREATE, USAGE ON SCHEMA public TO ws_migrator;
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ws_migrator, ws_tenant_app, ws_platform_app', current_database()) \gexec

-- Store and exchange all timestamps in UTC no matter what the server default is (PRD §12: waktu disimpan UTC)
SELECT format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC') \gexec
ALTER ROLE ws_migrator SET timezone TO 'UTC';
ALTER ROLE ws_tenant_app SET timezone TO 'UTC';
ALTER ROLE ws_platform_app SET timezone TO 'UTC';
