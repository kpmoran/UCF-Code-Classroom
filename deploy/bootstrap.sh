#!/usr/bin/env bash
#
# One-time server preparation. Run once, as root, on a fresh Linux host:
#
#   curl -fsSL https://raw.githubusercontent.com/kpmoran/UCF-Code-Connect/main/deploy/bootstrap.sh | bash -s -- code-connect.example.edu
#
# or, having cloned the repo:  sudo bash deploy/bootstrap.sh code-connect.example.edu
#
# Installs Docker, creates /opt/uccc, generates the secrets that must never leave
# this machine, and prepares a deploy user for GitHub Actions. It does NOT start
# the app: the GitHub App credentials have to be filled in first, and DNS has to
# resolve before Caddy can get a certificate.
#
# Idempotent. Re-running will not overwrite an existing .env or a deploy key.

set -euo pipefail

APP_DOMAIN="${1:-}"
if [[ -z "$APP_DOMAIN" ]]; then
  echo "usage: bootstrap.sh <domain>   e.g. bootstrap.sh code-connect.example.edu" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo bash deploy/bootstrap.sh $APP_DOMAIN)." >&2
  exit 1
fi

DIR=/opt/uccc
DEPLOY_USER=uccc-deploy

# Used for the DNS instruction and, more importantly, as DEPLOY_HOST: the deploy
# should not depend on public DNS resolving. If DNS breaks you still want to be able
# to ship a fix.
PUBLIC_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the OS can run this stack"
# Verified against Docker's own apt repository rather than assumed: as of writing,
# download.docker.com publishes a `xenial` suite but it contains NO
# docker-compose-plugin at all, and its newest docker-ce is 18.06.3 from 2018.
# This stack is `docker compose` (Compose v2, a CLI plugin), so on Ubuntu 16.04 it
# cannot run — Docker would install and then `docker compose` would not exist.
#
# Failing here with the reason beats installing a 2018 Docker and discovering the
# problem three steps later.
CODENAME="$( . /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-${UBUNTU_CODENAME:-unknown}}" )"
PRETTY="$( . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}" )"
case "$CODENAME" in
  noble|jammy|focal|bookworm|trixie)
    echo "$PRETTY — supported"
    ;;
  xenial|trusty|bionic|stretch|buster)
    cat >&2 <<UNSUPPORTED

$PRETTY is too old for this stack.

Docker publishes no docker-compose-plugin for "$CODENAME", and this deployment is
built on Compose v2 ('docker compose'). Its newest docker-ce for that release dates
from 2018. The release is also past its Ubuntu security-support window, which is a
poor place for an application holding student grades.

Fix: rebuild the host on Ubuntu 24.04 LTS. On Linode that is Rebuild in the
dashboard and it keeps the same IP address.

WARNING: a rebuild erases the disk. Only do it if there is nothing on this host you
need, or take a backup first.

UNSUPPORTED
    exit 1
    ;;
  *)
    echo "$PRETTY — not a release I have checked; continuing, but verify 'docker compose version' works afterwards." >&2
    ;;
esac

say "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  # Docker's convenience script, which is what Docker itself documents for this.
  curl -fsSL https://get.docker.com | sh
else
  echo "already installed: $(docker --version)"
fi
systemctl enable --now docker

# The whole stack is `docker compose`; confirm the plugin exists rather than finding
# out during the first deploy.
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' (Compose v2) is not available after installing Docker." >&2
  echo "       This host cannot run the stack. See the OS note above." >&2
  exit 1
fi
echo "compose: $(docker compose version --short 2>/dev/null || docker compose version)"

say "Creating $DIR"
mkdir -p "$DIR"
chmod 750 "$DIR"

say "Creating the deploy user"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  # A dedicated account with no password and no sudo. It can manage containers
  # (via the docker group) and nothing else, so a leaked deploy key is contained
  # to this application rather than being root on the box.
  #
  # Note that docker group membership is effectively root-equivalent on most
  # systems — it can bind-mount the host filesystem into a container. This limits
  # blast radius and keeps an audit trail; it is not a security boundary.
  useradd --system --create-home --shell /bin/bash "$DEPLOY_USER"
  echo "created $DEPLOY_USER"
else
  echo "$DEPLOY_USER already exists"
fi
usermod -aG docker "$DEPLOY_USER"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DIR"

say "Generating an SSH key for GitHub Actions"
KEY="/home/$DEPLOY_USER/.ssh/github-actions"
mkdir -p "/home/$DEPLOY_USER/.ssh"
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -N '' -C "github-actions@$APP_DOMAIN" -f "$KEY"
  cat "$KEY.pub" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"
else
  echo "key already exists, leaving it alone"
fi
chmod 700 "/home/$DEPLOY_USER/.ssh"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"

say "Hardening SSH"
# Port 22 must stay open to the internet: GitHub-hosted runners deploy over SSH and
# draw from more than 7,000 published address ranges, so allowlisting them in a
# firewall is not practical. Key-only authentication is therefore the control that
# actually matters, not the firewall.
#
# Guarded, and deliberately conservative. Disabling password authentication on a host
# whose only access is a password locks you out of your own server, and the only way
# back is the provider's serial console. So this looks for a key belonging to root or
# a sudo-capable user — NOT the deploy user, whose key this script just generated and
# which has no sudo. Finding none, it warns and changes nothing.
admin_key_found=0
[ -s /root/.ssh/authorized_keys ] && admin_key_found=1
for member in $(getent group sudo 2>/dev/null | awk -F: '{print $4}' | tr ',' ' '); do
  home_dir="$(getent passwd "$member" | cut -d: -f6)"
  [ -n "$home_dir" ] && [ -s "$home_dir/.ssh/authorized_keys" ] && admin_key_found=1
done

if [ "$admin_key_found" -eq 1 ]; then
  install -d -m 755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/99-uccc.conf <<'SSHEOF'
# Written by UCF-Code-Connect deploy/bootstrap.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHEOF
  # `sshd -t` validates the config but also insists on host keys, so it fails on a
  # host that has none yet — for an environment reason, not a problem with what we
  # wrote. Reverting on any non-zero exit silently threw away a good config; only a
  # complaint that actually names our file or a bad option should do that. sshd's own
  # message is printed either way rather than swallowed.
  sshd_check="$(sshd -t 2>&1 || true)"
  if printf '%s' "$sshd_check" | grep -qiE '99-uccc|bad configuration option|unsupported option'; then
    rm -f /etc/ssh/sshd_config.d/99-uccc.conf
    echo "WARNING: sshd rejected the hardened config, so it was reverted:" >&2
    printf '%s\n' "$sshd_check" | sed 's/^/    /' >&2
  else
    [ -n "$sshd_check" ] && {
      echo "note: sshd -t said (not about our config, so keeping it):"
      printf '%s\n' "$sshd_check" | sed 's/^/    /'
    }
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    echo "password authentication disabled; keys only"
  fi
else
  cat >&2 <<'NOKEY'

WARNING: password authentication left ENABLED.

No SSH key was found for root or any sudo user, so disabling passwords would have
locked you out. Port 22 is open to the internet, which is required for deploys, so
an open box with password login will be brute-forced.

Fix it:
    ssh-copy-id root@<this host>          # from your laptop
then re-run this script, or set by hand in /etc/ssh/sshd_config.d/99-uccc.conf:
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin prohibit-password

NOKEY
fi

say "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw --force enable >/dev/null
  ufw status numbered | sed 's/^/    /'
  # Enabling ufw rebuilds the iptables chains, which can drop the rules Docker
  # installed. Restarting the daemon makes it put them back, rather than leaving
  # container networking broken until the next reboot.
  systemctl restart docker >/dev/null 2>&1 || true
else
  echo "ufw not present — make sure 22, 80 and 443 are open and nothing else is."
fi

say "Writing $DIR/.env"
if [[ -f "$DIR/.env" ]]; then
  echo "already exists, not touching it"
else
  gen() { openssl rand -base64 32; }
  PGPASS="$(openssl rand -hex 24)"
  cat > "$DIR/.env" <<ENVEOF
APP_DOMAIN="$APP_DOMAIN"
APP_URL="https://$APP_DOMAIN"
# No previous hostname to keep alive on a fresh install. Setting this to the same
# value as APP_DOMAIN is how the Caddyfile is told "none" -- its redirect matcher
# excludes the canonical host, so this configuration is inert rather than a loop.
# After a rename, put the old hostname here so existing invite links keep working.
LEGACY_DOMAIN="$APP_DOMAIN"

POSTGRES_USER="uccc"
POSTGRES_PASSWORD="$PGPASS"
POSTGRES_DB="uccc"
DATABASE_URL="postgresql://uccc:$PGPASS@postgres:5432/uccc?schema=public"

AUTH_SECRET="$(gen)"
ENCRYPTION_KEY="$(gen)"
GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"

# ---- Fill these four in from your GitHub App's settings page ----
AUTH_GITHUB_ID=""
AUTH_GITHUB_SECRET=""
GITHUB_APP_ID=""
GITHUB_APP_PRIVATE_KEY=""

# Comma-separated GitHub logins that are always site admins. Set this before
# signing in, or nobody can create a classroom or invite anyone.
SITE_ADMIN_LOGINS=""

GITHUB_CONTENT_CALLS_PER_MINUTE="6"
GITHUB_CONTENT_CALLS_PER_HOUR="400"
RUN_WORKER="true"
RUN_MIGRATIONS="true"
NODE_ENV="production"
ENVEOF
  chmod 600 "$DIR/.env"
  chown "$DEPLOY_USER":"$DEPLOY_USER" "$DIR/.env"
  echo "generated with fresh secrets"
fi

cat <<SUMMARY

────────────────────────────────────────────────────────────────────────
Server is ready. Three things left, in this order.

1. Fill in the four GitHub App values:
       sudo -u $DEPLOY_USER nano $DIR/.env
   AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are the App's OAuth client id and
   secret; GITHUB_APP_ID is its numeric id; GITHUB_APP_PRIVATE_KEY is the .pem
   as one line:
       awk 'BEGIN{ORS="\\\\n"} {print}' your-app.private-key.pem

2. Point DNS at this host, and wait for it to resolve:
       $APP_DOMAIN  ->  ${PUBLIC_IP:-<this host public IP>}

3. Add these repository secrets under
   Settings -> Secrets and variables -> Actions:

   DEPLOY_HOST              ${PUBLIC_IP:-<this host public IP>}
   DEPLOY_USER              $DEPLOY_USER
   DEPLOY_SSH_KEY           the private key printed below
   DEPLOY_SSH_KNOWN_HOSTS   the host key printed below

   and one repository *variable*:

   APP_DOMAIN               $APP_DOMAIN

────────────────────────── DEPLOY_SSH_KEY ──────────────────────────────
SUMMARY
cat "$KEY"
cat <<'MID'
─────────────────────── DEPLOY_SSH_KNOWN_HOSTS ─────────────────────────
MID
# Keyed to the IP, matching DEPLOY_HOST above. An entry for the domain would not
# match a connection made to the address, and scanning the domain before its DNS
# record exists returns nothing at all.
if [[ -n "$PUBLIC_IP" ]]; then
  ssh-keyscan -t ed25519 "$PUBLIC_IP" 2>/dev/null || echo "(could not scan; run: ssh-keyscan -t ed25519 $PUBLIC_IP)"
else
  echo "(could not determine this host's public IP; run: ssh-keyscan -t ed25519 <ip>)"
fi
cat <<'END'
────────────────────────────────────────────────────────────────────────
Then push to main, or run the Deploy workflow by hand. The private key
above is now in your scrollback — clear it when you are done.
END
