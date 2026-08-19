#!/bin/sh
#
# Nightly pg_dump with verification and retention.
#
# Runs in a container built from the same postgres image as the server, which
# matters: pg_dump refuses to dump a server newer than itself, so pinning both to
# one image tag removes a failure that would otherwise appear only after a
# Postgres upgrade.
#
# Deliberately does its own scheduling rather than depending on cron. Busybox
# crond in this image would need root and a second process to supervise; a loop
# that computes the time until the next run is fewer moving parts and logs to
# stdout, where `docker compose logs backup` can see it.

set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_AT:-03:30}"
DB="${POSTGRES_DB:-uccc}"
USER="${POSTGRES_USER:-uccc}"
HOST="${POSTGRES_HOST:-postgres}"

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

log() { echo "[backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

seconds_until() {
  # $1 = HH:MM in UTC. Returns seconds until the next occurrence.
  target_h="${1%%:*}"
  target_m="${1##*:}"
  now_s=$(date -u +%s)
  today=$(date -u '+%Y-%m-%d')
  # busybox date cannot parse arbitrary strings, so compute from midnight instead.
  midnight=$(( now_s - ( $(date -u +%H) * 3600 ) - ( $(date -u +%M) * 60 ) - $(date -u +%S) ))
  run_s=$(( midnight + (target_h * 3600) + (target_m * 60) ))
  [ "$run_s" -le "$now_s" ] && run_s=$(( run_s + 86400 ))
  echo $(( run_s - now_s ))
}

take_backup() {
  mkdir -p "$DIR"
  stamp=$(date -u '+%Y-%m-%dT%H%M%SZ')
  out="$DIR/uccc-$stamp.dump"
  tmp="$out.partial"

  log "dumping $DB from $HOST"
  # Custom format: compressed, and pg_restore can then be selective and parallel.
  if ! pg_dump -h "$HOST" -U "$USER" -d "$DB" -Fc -f "$tmp" 2>/tmp/dumperr; then
    log "ERROR pg_dump failed: $(tr '\n' ' ' < /tmp/dumperr)"
    rm -f "$tmp"
    return 1
  fi

  # Verify before trusting it. A backup job that writes unusable files and prunes
  # good ones on a schedule is worse than having no backups at all, because it
  # replaces a known gap with false confidence.
  if ! pg_restore --list "$tmp" >/dev/null 2>&1; then
    log "ERROR dump is not a readable archive; discarding and keeping older backups"
    rm -f "$tmp"
    return 1
  fi

  size=$(wc -c < "$tmp" | tr -d ' ')

  # Compare what the dump contains against what the database actually has, rather
  # than guessing from the file size. A byte threshold cannot tell a truncated dump
  # from a legitimately empty schema, and the first attempt tuned one that rejected
  # exactly the empty-schema case — which is the normal state on a fresh deploy,
  # before the app has run its migrations.
  live_tables=$(psql -h "$HOST" -U "$USER" -d "$DB" -tAc \
    "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" \
    2>/dev/null | tr -d ' ' || echo 0)
  dump_tables=$(pg_restore --list "$tmp" 2>/dev/null | grep -c 'TABLE DATA' || true)

  if [ "${live_tables:-0}" -eq 0 ]; then
    # Not an error. The app has not migrated yet, so there is genuinely nothing to
    # preserve; saying "failed" here would train you to ignore this log.
    log "database has no tables yet — nothing to back up, skipping"
    rm -f "$tmp"
    return 0
  fi

  if [ "$dump_tables" -lt "$live_tables" ]; then
    log "ERROR dump holds $dump_tables tables but the database has $live_tables; discarding"
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$out"
  log "wrote $(basename "$out") (${size} bytes, ${dump_tables} tables)"
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$DIR/LAST_SUCCESS"

  # Pruned only after a verified success, so a run of failures can never age out
  # the last good backup.
  removed=$(find "$DIR" -name 'uccc-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
  [ "$removed" -gt 0 ] && log "pruned $removed backup(s) older than $KEEP_DAYS days"

  count=$(find "$DIR" -name 'uccc-*.dump' -type f | wc -l | tr -d ' ')
  log "$count backup(s) on disk"
  return 0
}

log "started; schedule ${AT} UTC, keeping ${KEEP_DAYS} days, writing to ${DIR}"

# One immediately on start, so a fresh deployment is covered straight away and a
# misconfiguration surfaces now rather than at 03:30 tomorrow.
#
# Skipped if something was already dumped in the last hour. `restart: unless-stopped`
# means a crash-looping container would otherwise write a dump per restart, filling
# the disk with near-identical copies — and retention is by age, so a fast enough loop
# outruns it.
recent=$(find "$DIR" -name 'uccc-*.dump' -type f -mmin -60 2>/dev/null | head -1)
if [ -n "$recent" ]; then
  log "a backup from the last hour already exists ($(basename "$recent")); skipping the startup run"
else
  take_backup || log "initial backup failed; will retry on schedule"
fi

while true; do
  wait_s=$(seconds_until "$AT")
  log "next run in $((wait_s / 3600))h $(((wait_s % 3600) / 60))m"
  sleep "$wait_s"
  take_backup || log "scheduled backup failed"
done
