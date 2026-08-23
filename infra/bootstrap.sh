#!/usr/bin/env bash
#
# One-time bootstrap for the droplet that fronts Ideate's Go services.
#
# Paste into DigitalOcean's "user data" field at droplet creation, or scp it and
# run it as root. It is **idempotent**: re-running after an edit is the intended
# way to change the shared configuration.
#
# It sets up the shared parts only — nginx, TLS, the firewall, the deploy user —
# and installs `ideate-service`, which is how each individual service gets added.
# Nothing here knows about the MCP service specifically; see infra/README.md
# for the two commands that put it on the box.
#
#   WARNING: user data is readable by *any* process on the droplet via the
#   metadata endpoint (169.254.169.254). Never put the Cloudflare origin private
#   key, or any other secret, in this file. DEPLOY_PUBKEY below is a public key,
#   so it is safe. The origin cert is installed by hand in step 3 of the runbook.
#
set -euo pipefail

# ── knobs ────────────────────────────────────────────────────────────
# An SSH public key for the unprivileged user CI deploys as. Leave empty to skip
# creating it and add the key later.
DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-}"
DEPLOY_USER=deploy
CERT_DIR=/etc/nginx/cloudflare
STATE_DIR=/etc/ideate
SWAP_SIZE=1G
# ─────────────────────────────────────────────────────────────────────

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "bootstrap.sh must run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log "Base packages"
apt-get update -qq
apt-get install -y -qq nginx ufw curl ca-certificates

log "Swap"
# DO droplets ship with none, and on a 512MB box a swapfile is the difference
# between a slow minute and the OOM killer taking out sshd.
if [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  # 512MB with swap wants to swap late, not eagerly.
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-ideate-swap.conf
  sysctl -q --system
else
  echo "swap already present, leaving it alone"
fi

log "Removing snapd"
# ~50-80MB of resident memory on DO's Ubuntu image for something nothing here
# uses. Tolerate failure: a future image may not ship it at all.
systemctl disable --now snapd.service snapd.socket snapd.seeded.service 2>/dev/null || true
apt-get purge -y -qq snapd 2>/dev/null || true

log "Directories"
mkdir -p "$CERT_DIR" "$STATE_DIR" /var/backups/ideate
chmod 755 "$CERT_DIR" "$STATE_DIR"

# The Cloudflare Origin CA that signs the client certificates Authenticated
# Origin Pulls presents. Public, and the same for every zone.
if [[ ! -s "$CERT_DIR/authenticated_origin_pull_ca.pem" ]]; then
  curl -fsSL -o "$CERT_DIR/authenticated_origin_pull_ca.pem" \
    https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
fi

# The service registry: one line per service, so the next one added cannot
# collide with a port already in use and `list` can answer what is on the box.
if [[ ! -f "$STATE_DIR/services.tsv" ]]; then
  printf '# name\tport\thostname\thealth\n' >"$STATE_DIR/services.tsv"
fi

log "Shared nginx configuration"
# :80 is never opened — Cloudflare reaches the origin on 443 and nothing here
# does ACME — so the stock site, which listens on it, goes.
rm -f /etc/nginx/sites-enabled/default

# http-context settings that must be declared exactly once, however many
# services later share this box. Putting any of these in a per-site file means
# the second service added makes nginx refuse to start on a duplicate.
cat >/etc/nginx/conf.d/00-ideate.conf <<'CONF'
# Required for WebSocket upgrades. A bare `proxy_set_header Connection upgrade`
# would break every non-upgrade request sharing the server block, so the header
# is derived from what the client actually sent.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

ssl_protocols       TLSv1.2 TLSv1.3;
ssl_session_cache   shared:SSL:2m;
ssl_session_timeout 1h;
server_tokens       off;

# Anything arriving for a hostname no service claims — the droplet's bare IP,
# a stale DNS record — is refused at the handshake rather than falling through
# to whichever site happens to be first.
server {
    listen      443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_reject_handshake on;
}
CONF

mkdir -p /etc/nginx/snippets

# The origin certificate is shared: request it for `haru.lk, *.haru.lk` and every
# service on this box is covered by the one cert.
cat >/etc/nginx/snippets/cloudflare-origin.conf <<'CONF'
ssl_certificate     /etc/nginx/cloudflare/origin.pem;
ssl_certificate_key /etc/nginx/cloudflare/origin.key;

# Authenticated Origin Pulls: refuse anything that did not come through
# Cloudflare. This is not belt-and-braces on top of the firewall — the services
# behind here trust CF-Connecting-IP unconditionally for rate limiting, so a
# request that reaches them another way can forge its own bucket.
ssl_client_certificate /etc/nginx/cloudflare/authenticated_origin_pull_ca.pem;
ssl_verify_client      on;
CONF

# Everything a proxied location needs except `proxy_pass`, which varies per
# service. The two easy-to-miss ones are here so a service added later cannot
# get them wrong: without the Upgrade pair, WebSockets fail; without buffering
# off, nginx holds a streaming response until it is complete.
cat >/etc/nginx/snippets/proxy-service.conf <<'CONF'
proxy_http_version 1.1;

proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;

proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
# CF-Connecting-IP arrives from Cloudflare and passes through untouched.

proxy_buffering         off;
proxy_request_buffering off;

proxy_read_timeout 1h;
proxy_send_timeout 1h;
CONF

log "Installing ideate-service"
cat >/usr/local/sbin/ideate-service <<'HELPER'
#!/usr/bin/env bash
#
# Add, list, remove and release the Go services behind nginx on this droplet.
#
# The convention every service follows:
#   binary       /usr/local/bin/<name>
#   environment  /etc/<name>.env          (mode 600, secrets live here)
#   unit         /etc/systemd/system/<name>.service
#   nginx site   /etc/nginx/sites-available/<name>
#   registry     /etc/ideate/services.tsv
#
# PORT is the one setting passed in the unit rather than the env file, because
# nginx and the service have to agree on it and the registry is what keeps them
# in step.
#
set -euo pipefail

REGISTRY=/etc/ideate/services.tsv
CERT_DIR=/etc/nginx/cloudflare
BACKUP_DIR=/var/backups/ideate

die() { echo "ideate-service: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage:
  ideate-service add <name> <port> <hostname> [options]
      --health PATH      health-check path            (default /healthz)
      --memory SIZE      systemd MemoryMax            (default 320M)
      --body SIZE        nginx client_max_body_size   (default 8m)
      --allow-egress     permit outbound connections  (default: loopback only)
  ideate-service list
  ideate-service release <name> <new-binary>
  ideate-service remove <name>
USAGE
}

require_root() { [[ $EUID -eq 0 ]] || die "must run as root"; }

lookup() { # name -> "port hostname health", empty if absent
  awk -F'\t' -v n="$1" '$1 == n { print $2, $3, $4 }' "$REGISTRY"
}

cmd_add() {
  require_root
  local name="${1:-}" port="${2:-}" host="${3:-}"
  shift 3 2>/dev/null || { usage; exit 1; }
  [[ -n "$name" && -n "$port" && -n "$host" ]] || { usage; exit 1; }
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "name must be lowercase alphanumeric with dashes"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port > 1024 && port < 65536 )) || die "port must be 1025-65535"

  local health=/healthz memory=320M body=8m egress=no
  while (( $# )); do
    case "$1" in
      --health) health="$2"; shift 2 ;;
      --memory) memory="$2"; shift 2 ;;
      --body)   body="$2";   shift 2 ;;
      --allow-egress) egress=yes; shift ;;
      *) die "unknown option $1" ;;
    esac
  done

  [[ -s "$CERT_DIR/origin.pem" && -s "$CERT_DIR/origin.key" ]] ||
    die "no origin certificate at $CERT_DIR — install it before adding a service"

  [[ -z "$(lookup "$name")" ]] || die "$name is already registered (ideate-service remove $name first)"
  local clash
  clash=$(awk -F'\t' -v p="$port" '$2 == p { print $1 }' "$REGISTRY")
  [[ -z "$clash" ]] || die "port $port is already taken by $clash"

  # Confined to loopback by default. A service that makes no outbound
  # connections has no business being able to, and nginx is the only thing that
  # should ever reach one of these ports.
  local netlines="IPAddressAllow=localhost
IPAddressDeny=any"
  [[ "$egress" == yes ]] && netlines="# egress permitted at add time"

  cat >"/etc/systemd/system/${name}.service" <<UNIT
[Unit]
Description=${name}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/${name}
Environment=PORT=${port}
EnvironmentFile=/etc/${name}.env
Restart=always
RestartSec=2

${netlines}

# These services keep no state on disk: everything they hold dies with a socket.
DynamicUser=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes

# A backstop, not a target: turns a runaway into a restart instead of a kernel
# OOM that might take nginx or sshd with it.
MemoryMax=${memory}

[Install]
WantedBy=multi-user.target
UNIT

  if [[ ! -f "/etc/${name}.env" ]]; then
    cat >"/etc/${name}.env" <<ENV
# Environment for ${name}. Secrets belong here, not in the unit.
# PORT is set by the unit from the service registry — do not set it here.
ENV
    chmod 600 "/etc/${name}.env"
  fi

  cat >"/etc/nginx/sites-available/${name}" <<SITE
server {
    listen      443 ssl;
    listen [::]:443 ssl;
    server_name ${host};

    include snippets/cloudflare-origin.conf;

    # Match the service's own body cap, so an oversized request gets the
    # service's error rather than a bare nginx 413 naming no limit.
    client_max_body_size ${body};

    location / {
        proxy_pass http://127.0.0.1:${port};
        include snippets/proxy-service.conf;
    }
}
SITE
  ln -sfn "/etc/nginx/sites-available/${name}" "/etc/nginx/sites-enabled/${name}"

  printf '%s\t%s\t%s\t%s\n' "$name" "$port" "$host" "$health" >>"$REGISTRY"

  systemctl daemon-reload
  nginx -t
  systemctl reload nginx

  echo "registered $name on 127.0.0.1:$port behind https://$host"
  echo "next: put the binary at /usr/local/bin/$name, fill /etc/$name.env,"
  echo "      then: systemctl enable --now $name"
}

cmd_list() {
  printf '%-20s %-7s %-32s %s\n' NAME PORT HOSTNAME STATE
  while IFS=$'\t' read -r name port host _health; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    printf '%-20s %-7s %-32s %s\n' "$name" "$port" "$host" \
      "$(systemctl is-active "$name" 2>/dev/null || true)"
  done <"$REGISTRY"
}

cmd_release() {
  require_root
  local name="${1:-}" binary="${2:-}"
  [[ -n "$name" && -n "$binary" ]] || { usage; exit 1; }
  [[ -s "$binary" ]] || die "$binary is missing or empty"

  local entry port health
  entry=$(lookup "$name")
  [[ -n "$entry" ]] || die "$name is not registered"
  read -r port _host health <<<"$entry"

  local live="/usr/local/bin/${name}" prev="${BACKUP_DIR}/${name}.prev"
  local rollback=no
  if [[ -f "$live" ]]; then
    cp -a "$live" "$prev"
    rollback=yes
  fi

  # install(1) writes to a temp name and renames, so the binary is never
  # half-written even if this dies mid-copy.
  install -m 0755 -o root -g root "$binary" "$live"
  systemctl restart "$name"

  # The restart severs every live WebSocket this service was holding. Both ends
  # reconnect; for Agent Link that costs the human one re-pair.
  local i
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}${health}" >/dev/null 2>&1; then
      echo "$name is healthy on :$port after ${i}s"
      return 0
    fi
    sleep 1
  done

  echo "ideate-service: $name did not pass ${health} within 20s" >&2
  if [[ "$rollback" == yes ]]; then
    echo "ideate-service: rolling back to the previous binary" >&2
    install -m 0755 -o root -g root "$prev" "$live"
    systemctl restart "$name"
  fi
  exit 1
}

cmd_remove() {
  require_root
  local name="${1:-}"
  [[ -n "$name" ]] || { usage; exit 1; }
  [[ -n "$(lookup "$name")" ]] || die "$name is not registered"

  systemctl disable --now "$name" 2>/dev/null || true
  rm -f "/etc/systemd/system/${name}.service" \
        "/etc/nginx/sites-enabled/${name}" \
        "/etc/nginx/sites-available/${name}"
  systemctl daemon-reload
  nginx -t && systemctl reload nginx

  local tmp
  tmp=$(mktemp)
  awk -F'\t' -v n="$name" '$1 != n' "$REGISTRY" >"$tmp"
  mv "$tmp" "$REGISTRY"
  chmod 644 "$REGISTRY"

  # The binary and the env file are left in place on purpose: the env file holds
  # secrets the operator may still want, and removing a service is not the same
  # decision as destroying its configuration.
  echo "removed $name (left /usr/local/bin/$name and /etc/$name.env in place)"
}

case "${1:-}" in
  add)     shift; cmd_add "$@" ;;
  list)    shift; cmd_list ;;
  release) shift; cmd_release "$@" ;;
  remove)  shift; cmd_remove "$@" ;;
  *)       usage; exit 1 ;;
esac
HELPER
chmod 755 /usr/local/sbin/ideate-service

log "Installing ideate-cf-firewall"
cat >/usr/local/sbin/ideate-cf-firewall <<'FIREWALL'
#!/usr/bin/env bash
#
# Sync the ufw rules that allow :443 so only Cloudflare's ranges can reach the
# origin. Cloudflare publishes changes rather than announcing them loudly, so
# this runs on a timer.
#
# It diffs against the last applied list rather than re-adding blindly, so a
# range Cloudflare drops actually stops being allowed.
#
set -euo pipefail

STATE=/etc/ideate/cloudflare-ips.txt
NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT

{ curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4
  curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6
} | tr -d '\r' | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' | sort -u >"$NEW"

# A failed or truncated fetch must never be read as "Cloudflare has no ranges" —
# acting on that would delete every allow rule and take the origin offline.
count=$(wc -l <"$NEW")
if (( count < 10 )); then
  echo "ideate-cf-firewall: refusing to apply $count ranges (fetch looks broken)" >&2
  exit 1
fi

touch "$STATE"
added=0 removed=0
while read -r cidr; do
  ufw allow proto tcp from "$cidr" to any port 443 >/dev/null
  (( ++added ))
done < <(comm -13 "$STATE" "$NEW")

while read -r cidr; do
  ufw --force delete allow proto tcp from "$cidr" to any port 443 >/dev/null 2>&1 || true
  (( ++removed ))
done < <(comm -23 "$STATE" "$NEW")

install -m 644 "$NEW" "$STATE"
echo "ideate-cf-firewall: $count ranges allowed on :443 (+$added, -$removed)"
FIREWALL
chmod 755 /usr/local/sbin/ideate-cf-firewall

cat >/etc/systemd/system/ideate-cf-firewall.service <<'UNIT'
[Unit]
Description=Sync ufw :443 allow rules with Cloudflare's published ranges
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ideate-cf-firewall
UNIT

cat >/etc/systemd/system/ideate-cf-firewall.timer <<'UNIT'
[Unit]
Description=Weekly Cloudflare range refresh

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

log "Firewall"
# SSH first, and before enabling: the order here is the difference between a
# firewall and a lockout.
ufw allow 22/tcp >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
systemctl daemon-reload
systemctl enable --now ideate-cf-firewall.timer
/usr/local/sbin/ideate-cf-firewall

if [[ -n "$DEPLOY_PUBKEY" ]]; then
  log "Deploy user"
  id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEPLOY_USER"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  printf '%s\n' "$DEPLOY_PUBKEY" >"/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"

  # CI gets exactly one privileged verb: swap a binary and restart its service.
  # Not `add`, not `remove` — registering a service is an operator decision, and
  # a leaked CI key should not be able to make it.
  cat >/etc/sudoers.d/ideate-deploy <<SUDO
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/sbin/ideate-service release *
SUDO
  chmod 440 /etc/sudoers.d/ideate-deploy
  visudo -cf /etc/sudoers.d/ideate-deploy
else
  echo "DEPLOY_PUBKEY not set — skipping the deploy user"
fi

log "Done"
cat <<'NEXT'
Shared setup is in place. Still to do, by hand:

  1. Install the Cloudflare origin certificate (never put the key in user data):
       scp origin.pem origin.key root@<droplet>:/etc/nginx/cloudflare/
       chown root:root /etc/nginx/cloudflare/origin.key && chmod 600 /etc/nginx/cloudflare/origin.key
       systemctl reload nginx

  2. Turn on SSL/TLS -> Origin Server -> Authenticated Origin Pulls in Cloudflare.
     With ssl_verify_client on and AOP off, every handshake fails with 526.

  3. Add a service:
       ideate-service add ideate-mcp 7391 ideate-mcp.haru.lk
       $EDITOR /etc/ideate-mcp.env
       systemctl enable --now ideate-mcp

  ideate-service list shows what is on the box.
NEXT
