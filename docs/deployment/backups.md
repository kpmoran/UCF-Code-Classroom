# Backups

The `backup` service takes a verified `pg_dump` nightly at 03:30 UTC (set
`BACKUP_AT`), keeps 14 days (`BACKUP_KEEP_DAYS`), and writes to `/opt/uccc/backups`
on the host — a plain directory rather than a Docker volume, precisely so copying
dumps off the machine is just `scp` against a path you can see.

```bash
cd /opt/uccc
docker compose logs backup                                  # what it has been doing
cat backups/LAST_SUCCESS                                    # when it last worked
docker compose run --rm backup /restore.sh --list           # what is available
```

Dumps are written `0640` and owned by root, so they are not readable by other
accounts on the host — a file holding the whole student database should not be
world-readable, which it was until `umask 027` was set in `backup.sh`.

**Both copies are on one machine.** The dumps live on the app server's disk, and
Linode's VM backups include that directory but stay in the same data centre — so a
lost region or a compromised account takes both. [`deploy/backup/README-offsite.md`](https://github.com/kpmoran/UCF-Code-Classroom/blob/main/deploy/backup/README-offsite.md)
sets up a third copy on a second host, pulled rather than pushed so the app server
holds no credential that could delete it. Linode's own docs recommend exactly this,
and note that snapshots of a *running* database may be caught mid-transaction —
which is why the verified `pg_dump` inside the image is what you actually restore
from.

Restoring — destructive, and it asks before proceeding:

```bash
docker compose run --rm backup /restore.sh                  # newest
docker compose run --rm backup /restore.sh uccc-2026-...dump  # a specific one
docker compose restart app                                  # reconnect cleanly
```

Three deliberate choices, each because the obvious version fails quietly:

- **Every dump is verified before anything is pruned.** `pg_restore --list` must parse
  it, and it must contain at least as many tables as the live database. A job that
  writes unusable files while deleting good ones on a schedule is worse than no
  backups, because it replaces a known gap with false confidence.
- **An empty schema is "nothing to back up", not a failure.** The container starts as
  soon as Postgres is healthy, which on a fresh deploy is before the app has migrated.
  Reporting that as an error would train you to ignore this log.
- **The startup backup is skipped if one exists from the last hour.** `restart:
  unless-stopped` plus a crash loop would otherwise write a dump per restart, and
  retention is by age, so a fast enough loop outruns it.

Verified by restoring, not by reading: rows written, dumped, truncated through 13
cascading tables, restored, and every value checked including booleans — then the app
health-checked green on top of the restored database.

# Getting backups off the box

**The above is only half a backup.** Dumps on `/opt/uccc/backups` protect you from the
common disaster — a bad migration, a mistaken delete, a corrupted table. They do not
survive losing the disk, which is the rarer and worse one.

Simplest fix, from your own machine:

```bash
rsync -avz --delete \
  uccc-deploy@<host>:/opt/uccc/backups/ ~/uccc-backups/
```

Nightly, in your laptop's crontab:

```
30 8 * * * rsync -az --delete uccc-deploy@<host>:/opt/uccc/backups/ ~/uccc-backups/
```

That depends on the laptop being awake, so for something you would rather not think
about, Linode Object Storage is the proper answer: an S3-compatible bucket the server
pushes to on its own. It needs an access key pair and a push from the backup container, which is not
wired up yet.

A restore you have never performed is a hope, not a plan. Once real grades are in
there, do a drill: `restore.sh --list`, restore the newest into a scratch database,
and confirm the row counts. Better to find a problem on a Tuesday than in week 14.
