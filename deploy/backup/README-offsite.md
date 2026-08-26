# Off-box backup copies

The nightly `pg_dump` lands in `/opt/uccc/backups` on the app server, and Linode's
VM backups include that directory. Both copies live on the same machine in the same
data centre, and Akamai's own documentation says so plainly: backups "are stored
within the same data center as your Linode", with the recommendation to "regularly
backup your data off-site". One lost region, or one compromised account, takes both.

This sets up a third copy on a second Linode (`45.33.96.10`).

## The direction matters

**The backup host pulls. The app server never pushes.**

A push means the app server holds a credential that can write to — and therefore
delete from — the only off-box copy, so whatever compromises the app server takes
the backups with it. That is the failure this whole exercise exists to prevent.
Pulling means the app server holds no credential at all, and the key on the backup
host is restricted to read-only rsync of one directory.

For the same reason the pull never passes `--delete`. This is a mirror of an
archive, not of a directory: the app server prunes at 14 days and that retention is
not ours to inherit, and `--delete` would faithfully replicate an accidental or
malicious wipe.

## 1. On the app server: a read-only account

The dumps are `0640` and owned by root, so give the puller a group rather than a
root login.

```bash
sudo groupadd uccc-backup
sudo useradd -m -g uccc-backup -s /bin/sh backup-reader

# setgid so every new dump inherits the group; 0750 so nobody else can look.
sudo chgrp -R uccc-backup /opt/uccc/backups
sudo chmod 2750 /opt/uccc/backups
sudo chmod 0640 /opt/uccc/backups/*.dump    # once, for files written before umask 027
```

Confirm it worked, as the new user:

```bash
sudo -u backup-reader ls -l /opt/uccc/backups | head
```

If that fails, `/opt/uccc` itself is probably not traversable — `sudo chmod o+x /opt/uccc`.

## 2. On the backup host (45.33.96.10): the key and the script

Generate the key **here**, so the private half never exists on the app server:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/uccc-offsite -C 'uccc offsite pull'
sudo mkdir -p /srv/uccc-backups /opt/uccc-offsite
sudo chown "$USER" /srv/uccc-backups
```

Copy `offsite-pull.sh` from this repository to `/opt/uccc-offsite/offsite-pull.sh`
and `chmod +x` it. Then print the public key — you need it in step 3:

```bash
cat ~/.ssh/uccc-offsite.pub
```

## 3. Back on the app server: restrict what that key can do

Find `rrsync`, which ships with rsync and wraps it to a single directory:

```bash
ls /usr/bin/rrsync /usr/share/rsync/rrsync 2>/dev/null
# Debian/Ubuntu with rsync >= 3.2.4: /usr/bin/rrsync
# older packages: /usr/share/rsync/rrsync (may need `gunzip` first)
```

Then add the public key to `backup-reader`, forcing that command:

```bash
sudo -u backup-reader mkdir -p /home/backup-reader/.ssh
sudo -u backup-reader tee -a /home/backup-reader/.ssh/authorized_keys <<'KEY'
command="/usr/bin/rrsync -ro /opt/uccc/backups",restrict ssh-ed25519 AAAA...PASTE_THE_PUBLIC_KEY... uccc offsite pull
KEY
sudo -u backup-reader chmod 700 /home/backup-reader/.ssh
sudo -u backup-reader chmod 600 /home/backup-reader/.ssh/authorized_keys
```

`-ro` is read-only and `restrict` disables port forwarding, agent forwarding and
PTY allocation. The key cannot get a shell, cannot write, and cannot see anything
outside `/opt/uccc/backups` — so this is worth doing properly rather than reusing an
existing login.

Verify the restriction actually holds, from the backup host:

```bash
ssh -i ~/.ssh/uccc-offsite backup-reader@APP_SERVER_IP        # must NOT give a shell
```

## 4. Run it

```bash
OFFSITE_SOURCE=backup-reader@APP_SERVER_IP /opt/uccc-offsite/offsite-pull.sh
```

First run also settles the host key, since the script uses
`StrictHostKeyChecking=yes` rather than accepting whatever answers:

```bash
ssh-keyscan -H APP_SERVER_IP >> ~/.ssh/known_hosts
```

## 5. Schedule it

The app server dumps at 03:30 UTC, so pull at 04:30 and let it settle:

```cron
30 4 * * * OFFSITE_SOURCE=backup-reader@APP_SERVER_IP /opt/uccc-offsite/offsite-pull.sh
```

Cron mails you the output on a non-zero exit, which is deliberate: the script fails
loudly when the newest dump is over 48 hours old. A transfer can succeed perfectly
while pulling a directory that stopped being updated a week ago, and that is the
failure most likely to actually happen — silence from a backup job is
indistinguishable from success.

Make sure cron can reach you (`MAILTO=`, and a working local mailer), or wrap the
line in whatever alerting you already use.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OFFSITE_SOURCE` | *(required)* | `user@host` of the app server |
| `OFFSITE_SOURCE_DIR` | `/opt/uccc/backups/` | Remote directory |
| `OFFSITE_DEST` | `/srv/uccc-backups` | Local archive |
| `OFFSITE_KEEP_DAYS` | `120` | Longer than the app server's 14 on purpose |
| `OFFSITE_SSH_KEY` | `~/.ssh/uccc-offsite` | Private key |
| `OFFSITE_MAX_AGE_HOURS` | `48` | Staleness that counts as failure |

## Checking on it

```bash
cat /srv/uccc-backups/LAST_PULL
ls -lh /srv/uccc-backups | tail
```

## Restoring from this copy

The dumps are ordinary `pg_dump -Fc` archives, so copy one back and use the
existing restore path:

```bash
scp /srv/uccc-backups/uccc-2026-....dump APP_SERVER:/opt/uccc/backups/
# then, on the app server:
cd /opt/uccc && docker compose run --rm backup /restore.sh uccc-2026-....dump
```

Rehearse this once against a throwaway database before you need it. An unexercised
restore path is a hypothesis, and `/restore.sh` is destructive — it passes
`--clean`, so anything written since that dump is gone.
