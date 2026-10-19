#!/usr/bin/env bash
# Local PostgreSQL for development and tests (no Docker needed). Data lives in ./.pgdata (gitignored).
#   scripts/dev-db.sh up      initialise (first run) + start + bootstrap roles + migrate
#   scripts/dev-db.sh down    stop
#   scripts/dev-db.sh reset   destroy data and start over
set -euo pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$( (brew --prefix postgresql@16 2>/dev/null || true) | sed 's|$|/bin|')}"
[ -x "$PGBIN/initdb" ] || PGBIN="$(dirname "$(command -v initdb || command -v pg_ctl)")"
export PATH="$PGBIN:$PATH"
PORT="${DEV_DB_PORT:-54329}"; DATA=".pgdata"; DB="websekolah"
MIG_PW="${DEV_MIG_PW:-dev-migrator-pw}"; TEN_PW="${DEV_TENANT_PW:-dev-tenant-pw}"; PLAT_PW="${DEV_PLATFORM_PW:-dev-platform-pw}"
cmd="${1:-up}"
case "$cmd" in
  down) pg_ctl -D "$DATA" stop -m fast || true ;;
  reset) pg_ctl -D "$DATA" stop -m fast 2>/dev/null || true; rm -rf "$DATA"; exec "$0" up ;;
  up)
    if [ ! -d "$DATA" ]; then
      echo "$MIG_PW" > /dev/null
      initdb -D "$DATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 >/dev/null
    fi
    pg_ctl -D "$DATA" status >/dev/null 2>&1 || pg_ctl -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -l "$DATA/server.log" -w start >/dev/null 2>&1 </dev/null
    psql -h /tmp -p "$PORT" -U postgres -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
      || psql -h /tmp -p "$PORT" -U postgres -d postgres -c "CREATE DATABASE $DB" >/dev/null
    psql -h /tmp -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q \
      -v mig_pw="$MIG_PW" -v tenant_pw="$TEN_PW" -v platform_pw="$PLAT_PW" -f scripts/db-bootstrap.sql >/dev/null
    export DATABASE_URL_MIGRATE="postgresql://ws_migrator:$MIG_PW@127.0.0.1:$PORT/$DB"
    npx prisma migrate deploy
    echo "DB ready on :$PORT"
    echo "DATABASE_URL_TENANT=postgresql://ws_tenant_app:$TEN_PW@127.0.0.1:$PORT/$DB"
    echo "DATABASE_URL_PLATFORM=postgresql://ws_platform_app:$PLAT_PW@127.0.0.1:$PORT/$DB"
    ;;
  *) echo "usage: $0 up|down|reset"; exit 1 ;;
esac
