#!/bin/bash
# ===========================================================================
# user-data.sh -- pasted into EC2 "User data" field at instance launch.
# Runs once as root on first boot. Idempotent: rerunning the same script on
# an existing instance is safe.
#
# What it does:
#   1. Installs Node.js 20, git, and Caddy (for free HTTPS).
#   2. Creates a low-privilege user `sbg` to run the app.
#   3. Clones the repo into /opt/sbg-tracker, installs deps, runs migrations.
#   4. Writes a systemd unit so the backend auto-starts and restarts on crash.
#   5. Writes a Caddyfile that reverse-proxies port 80/443 -> 3001 and gets a
#      free Let's Encrypt cert IF you've pointed a domain at the instance.
# ===========================================================================
set -euxo pipefail

# --- 1. System packages ----------------------------------------------------
dnf update -y
dnf install -y git tar gzip awscli

# Node.js 20 from NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Caddy (for HTTPS reverse proxy)
dnf install -y 'dnf-command(copr)'
dnf copr enable -y @caddy/caddy || true
dnf install -y caddy || true

# --- 2. Application user ---------------------------------------------------
id sbg &>/dev/null || useradd --system --create-home --shell /bin/bash sbg

# --- 3. Clone + install ----------------------------------------------------
APP_DIR=/opt/sbg-tracker
if [ ! -d "$APP_DIR" ]; then
  git clone https://github.com/saic97/sbg-tracker.git "$APP_DIR"
fi
chown -R sbg:sbg "$APP_DIR"

sudo -u sbg bash -c "cd $APP_DIR/backend && npm ci --omit=dev || npm install --omit=dev"
sudo -u sbg bash -c "cd $APP_DIR/backend && npm run migrate"
sudo -u sbg bash -c "cd $APP_DIR/backend && npm run seed || true"

# --- 4. systemd unit -------------------------------------------------------
install -m 0644 "$APP_DIR/deploy/aws/sbg-tracker.service" /etc/systemd/system/sbg-tracker.service
systemctl daemon-reload
systemctl enable --now sbg-tracker

# --- 5. Caddy reverse proxy ------------------------------------------------
# If a CADDY_DOMAIN env var is set on the instance (via /etc/sbg-tracker.env),
# Caddy will auto-acquire a Let's Encrypt cert. Otherwise it serves plain HTTP.
install -m 0644 "$APP_DIR/deploy/aws/Caddyfile" /etc/caddy/Caddyfile
systemctl enable --now caddy || true

echo "[user-data] done. App should be reachable on port 3001 (or 80 via Caddy)."
