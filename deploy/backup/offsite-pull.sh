#!/bin/bash
#
# Pull the app server's database dumps to this machine.
#
# Runs on the *backup* host, not on the app server. That direction is the whole
# point: a push would mean the app server holds a credential that can write to —
# and therefore delete from — the only off-box copy of the data, so anything that
# compromises the app server takes the backups with it. Pulling means the app
# server holds no credential at all, and the key here is restricted to read-only
# rsync of one directory (see deploy/backup/README-offsite.md).
#
# Usage, normally from cron:
#   OFFSITE_SOURCE=user@app-host /opt/uccc-offsite/offsite-pull.sh
#
# Exits non-zero when the newest dump is too old, so cron mails you. Silence from
# a backup job is indistinguishable from success, which is how people discover in
# an emergency that it stopped working months ago.

set -euo pipefail

SOURCE="${OFFSITE_SOURCE:?set OFFSITE_SOURCE, e.g. deploy@app.example.com}"
SOURCE_DIR="${OFFSITE_SOURCE_DIR:-/opt/uccc/backups/}"
DEST="${OFFSITE_DEST:-/srv/uccc-backups}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-120}"
SSH_KEY="${OFFSITE_SSH_KEY:-$HOME/.ssh/uccc-offsite}"
# How stale the newest dump may be before this is treated as a failure. The app
# server dumps nightly, so 48h tolerates one missed run without crying wolf.
MAX_AGE_HOURS="${OFFSITE_MAX_AGE_HOURS:-48}"

log() { echo "[offsite] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

mkdir -p "$DEST"

# One at a time. Cron overlapping a slow transfer would have two rsyncs writing
# the same files.
exec 9>"$DEST/.pull.lock"
if ! flock -n 9; then
  log "another pull is still running; leaving it alone"
  exit 0
fi

# One variable rather than two joined at the call site, so a test can point this at
# a local directory and exercise the real rsync — including --exclude, which a
# stubbed rsync silently ignores and which is the only thing keeping half-written
# .partial files out of the archive.
REMOTE="${OFFSITE_REMOTE:-$SOURCE:$SOURCE_DIR}"

log "pulling from $REMOTE"

# Deliberately no --delete.
#
# This is a mirror of an archive, not a mirror of a directory. The source prunes on
# a 14-day schedule and its retention is not ours to inherit — that is the reason
# this copy exists. --delete would also faithfully replicate a malicious or
# accidental wipe, turning the off-box copy into a second victim rather than a
# recovery path. Dumps are named by timestamp and never rewritten, so plain rsync
# converges without it.
#
# --partial dumps are excluded: the source writes .partial and renames on success,
# so a .partial here is a half-written file we would then have to reason about.
rsync -avz --timeout=300 \
  --exclude '*.partial' \
  --exclude '.pull.lock' \
  -e "ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes" \
  "$REMOTE" "$DEST/"

# Verify what arrived, rather than trusting that rsync exiting 0 means the files are
# dumps. Postgres custom-format archives begin with the five bytes "PGDMP"; checking
# the magic needs no postgres client on this host, which keeps the backup machine
# from having to track the server's Postgres version.
bad=0
checked=0
while IFS= read -r -d '' f; do
  checked=$((checked + 1))
  if [ "$(head -c 5 "$f")" != "PGDMP" ]; then
    log "ERROR $(basename "$f") is not a Postgres custom-format archive"
    bad=$((bad + 1))
  fi
done < <(find "$DEST" -name 'uccc-*.dump' -type f -print0)

if [ "$checked" -eq 0 ]; then
  log "ERROR no dumps present after the pull"
  exit 1
fi
if [ "$bad" -gt 0 ]; then
  log "ERROR $bad of $checked archives are unreadable; not pruning"
  exit 1
fi

# Freshness. A transfer can succeed perfectly and still be pulling a stale
# directory because the source's own backup job died a week ago — the failure this
# is most likely to actually catch.
# Age from the filename, which the dump job writes as an explicit UTC stamp
# (uccc-2026-08-26T033000Z.dump), rather than from the local mtime. mtime is a
# property of *this* copy: it survives `rsync -a` but not a restore from a Linode
# image, a `cp -r`, or a move between filesystems, and each of those would silently
# make a months-old archive look like it arrived this morning — turning the one
# check that catches a dead upstream job into a check that always passes.
newest_file=$(find "$DEST" -name 'uccc-*.dump' -type f | sort | tail -1)
stamp=$(basename "${newest_file:-}" | sed -n 's/^uccc-\(.*\)\.dump$/\1/p')

# Normalise 2026-08-26T033000Z into something `date` will parse.
parsed=$(printf '%s' "$stamp" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)T\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)Z$/\1 \2:\3:\4 UTC/p')
if [ -n "$parsed" ] && newest_epoch=$(date -d "$parsed" +%s 2>/dev/null); then
  :
else
  # A dump whose name we cannot read still gets checked, just by mtime. Better a
  # weaker signal than none, and the name is ours so this should not happen.
  log "note: cannot read a timestamp from $(basename "${newest_file:-none}"); falling back to mtime"
  newest_epoch=$(date -r "$newest_file" +%s)
fi
age_hours=$(( ( $(date +%s) - newest_epoch ) / 3600 ))

log "$checked archive(s) verified; newest $(basename "$newest_file") is ${age_hours}h old"

# Prune only after everything above passed, so a spell of failures can never age
# out the last good copy — the same rule the on-server job follows.
removed=$(find "$DEST" -name 'uccc-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$removed" -gt 0 ] && log "pruned $removed archive(s) older than $KEEP_DAYS days"

date -u '+%Y-%m-%dT%H:%M:%SZ' > "$DEST/LAST_PULL"

if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
  log "ERROR newest dump is ${age_hours}h old, over the ${MAX_AGE_HOURS}h limit — is the app server still dumping?"
  exit 1
fi

log "ok"
