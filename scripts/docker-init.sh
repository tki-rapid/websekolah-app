#!/bin/sh
set -eu
psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -v mig_pw=dev-migrator-pw -v tenant_pw=dev-tenant-pw -v platform_pw=dev-platform-pw -f /sql/db-bootstrap.sql
