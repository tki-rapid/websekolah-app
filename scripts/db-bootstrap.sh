#!/bin/sh
# Runs scripts/db-bootstrap.sql with the admin connection. Inputs (env): ADMIN_DATABASE_URL, MIG_PW, TENANT_PW, PLATFORM_PW.
set -eu
: "${ADMIN_DATABASE_URL:?}" "${MIG_PW:?}" "${TENANT_PW:?}" "${PLATFORM_PW:?}"
exec psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -v mig_pw="$MIG_PW" -v tenant_pw="$TENANT_PW" -v platform_pw="$PLATFORM_PW" -f /sql/db-bootstrap.sql
