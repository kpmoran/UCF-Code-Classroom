#!/bin/sh
#
# Restore a dump over the live database.
#
#   cd /opt/uccc
#   docker compose run --rm backup /restore.sh --list             # what is available
#   docker compose run --rm backup /restore.sh                    # newest backup
#   docker compose run --rm backup /restore.sh uccc-2026-...dump  # a specific one
#
# These work because the compose service puts the backup loop in `command`, not
# `entrypoint`, so naming a script here replaces it.
#
# Destructive: --clean drops and recreates every object the dump contains, so
# anything written since that dump is gone. It asks for confirmation unless
# BACKUP_RESTORE_YES=1 is set.

set -eu

DIR="${BACKUP_DIR:-/backups}"
DB="${POSTGRES_DB:-uccc}"
USER="${POSTGRES_USER:-uccc}"
HOST="${POSTGRES_HOST:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

log() { echo "[restore] $*"; }

if [ "${1:-}" = "--list" ]; then
  log "backups in $DIR (newest last):"
  ls -lh "$DIR"/uccc-*.dump 2>/dev/null | awk '{print "   " $9 "  " $5}' || log "  none found"
  [ -f "$DIR/LAST_SUCCESS" ] && log "last successful backup: $(cat "$DIR/LAST_SUCCESS")"
  exit 0
fi

if [ -n "${1:-}" ]; then
  FILE="$DIR/$(basename "$1")"
else
  # Newest by name, which sorts correctly because the stamp is ISO-8601.
  FILE=$(ls "$DIR"/uccc-*.dump 2>/dev/null | sort | tail -1 || true)
fi

[ -n "${FILE:-}" ] && [ -f "$FILE" ] || { log "ERROR no such backup: ${1:-<none found>}"; exit 1; }

log "archive:  $FILE"
log "contents: $(pg_restore --list "$FILE" | grep -c 'TABLE DATA' || echo 0) tables with data"
log "target:   $DB on $HOST"

if [ "${BACKUP_RESTORE_YES:-}" != "1" ]; then
  printf '[restore] This REPLACES the current contents of %s. Type RESTORE to continue: ' "$DB"
  read -r answer
  [ "$answer" = "RESTORE" ] || { log "aborted"; exit 1; }
fi

log "restoring..."
# --clean --if-exists so it works whether or not the objects are already there;
# --no-owner because roles differ between environments and ownership is not
# something this application depends on.
pg_restore -h "$HOST" -U "$USER" -d "$DB" --clean --if-exists --no-owner --single-transaction "$FILE"

log "done. Restart the app so it reconnects cleanly:  docker compose restart app"
