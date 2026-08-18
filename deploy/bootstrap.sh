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

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  # Docker's convenience script, which is what Docker itself documents for this.
  curl -fsSL https://get.docker.com | sh
else
  echo "already installed: $(docker --version)"
fi
systemctl enable --now docker

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

say "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw --force enable >/dev/null
  ufw status numbered | sed 's/^/    /'
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
       $APP_DOMAIN  ->  $(curl -fsS4 https://api.ipify.org 2>/dev/null || echo '<this host public IP>')

3. Add these repository secrets under
   Settings -> Secrets and variables -> Actions:

   DEPLOY_HOST              $APP_DOMAIN
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
ssh-keyscan -t ed25519 -H "$(hostname -f 2>/dev/null || hostname)" 2>/dev/null || true
ssh-keyscan -t ed25519 "$APP_DOMAIN" 2>/dev/null || echo "(run: ssh-keyscan $APP_DOMAIN   once DNS resolves)"
cat <<'END'
────────────────────────────────────────────────────────────────────────
Then push to main, or run the Deploy workflow by hand. The private key
above is now in your scrollback — clear it when you are done.
END
