# infra

The droplet that hosts Ideate's Go services, and the pipeline that ships to it.

Two files:

- **`bootstrap.sh`** — one-time droplet setup. Shared parts only: nginx, TLS,
  firewall, deploy user. It installs `ideate-service`, which is how each
  individual service is added, and it is idempotent — re-running it after an edit
  is the intended way to change the shared configuration.
- **`../.github/workflows/relay.yml`** — verify → build → release → deploy.

`bootstrap.sh` deliberately knows nothing about the relay. Everything
service-specific is two commands, below.

## Why nginx and systemd rather than Caddy and Docker

The box is the $4 / 512MB droplet, and the two decisions are about what that
leaves for the services themselves:

| | idle RSS |
| --- | --- |
| dockerd + containerd | ~100–150MB |
| Caddy | ~30–45MB |
| nginx (master + worker) | ~10–15MB |

Docker was the larger cost by far, and it was wrapping a static binary with no
dependencies, no volumes and no egress — `systemd` does that for nothing. Caddy's
headline feature is automatic HTTPS, and this deployment does not use it: the
certificate is Cloudflare's origin cert, installed by hand, valid for 15 years.

What nginx costs in exchange is two directives Caddy gets right by default and
that silently break things when missed — the WebSocket `Upgrade` pair and
`proxy_buffering off`. Both live in `/etc/nginx/snippets/proxy-service.conf`,
included by every site `ideate-service` generates, so a service added later cannot
get them wrong.

## Bringing up a droplet

1. **Create it.** Ubuntu 24.04, 512MB / 1 vCPU. Paste `bootstrap.sh` into the
   user-data field, with `DEPLOY_PUBKEY` at the top set to the public half of the
   key CI will use. **Nothing secret goes in user data** — it is readable by any
   process on the droplet through the metadata endpoint.

2. **DNS.** A record for each service hostname → droplet IP, **proxied** (orange
   cloud).

3. **Origin certificate.** Cloudflare → SSL/TLS → Origin Server → Create
   Certificate. Request it for `haru.lk, *.haru.lk` and every service on this box
   shares the one cert.

   ```sh
   scp origin.pem origin.key root@<droplet>:/etc/nginx/cloudflare/
   ssh root@<droplet> 'chown root:root /etc/nginx/cloudflare/origin.key && chmod 600 /etc/nginx/cloudflare/origin.key && systemctl reload nginx'
   ```

4. **Authenticated Origin Pulls: on** (SSL/TLS → Origin Server). The nginx config
   sets `ssl_verify_client on`, so with AOP off every handshake fails and
   Cloudflare serves 526. This is not defence in depth — the services trust
   `CF-Connecting-IP` unconditionally for rate limiting, so a request that reaches
   them without passing through Cloudflare can forge its own bucket.

5. **Zone settings.** SSL/TLS mode **Full (strict)**; Network → **WebSockets on**;
   a Cache Rule bypassing cache for each service hostname; **Bot Fight Mode off**
   or a WAF skip rule for the hostname — MCP clients are not browsers, and a
   managed challenge on `/mcp` breaks the transport with an error nobody can read.

## Adding the relay

```sh
ideate-service add ideate-relay 7391 ideate-mcp.haru.lk
```

Then fill in `/etc/ideate-relay.env`:

```sh
PUBLIC_URL=https://ideate-mcp.haru.lk
ALLOWED_ORIGINS=https://ideate.haru.lk
STATS_USER=ops
STATS_PASSWORD=<long random string>
# 512MB box: half the default inflight budget. Must stay >= one 8MB frame.
MAX_INFLIGHT_BYTES=33554432
```

`PORT` is set by the unit from the service registry — do not put it here, or the
two copies will disagree the first time one is changed.

The first binary has to be placed by hand, since `ideate-service release` expects
a service that already exists; after that the pipeline does it:

```sh
systemctl enable --now ideate-relay
```

## Adding a service later

```sh
ideate-service add <name> <port> <hostname> [--health PATH] [--memory 320M] [--body 8m] [--allow-egress]
```

That writes the systemd unit, the nginx site, and an empty `/etc/<name>.env`, then
records the service in `/etc/ideate/services.tsv` — which is what makes a port
collision an error at `add` time rather than a service that silently fails to
bind. `ideate-service list` shows what is on the box and whether each is running.

Two defaults worth knowing:

- **Loopback only.** Units get `IPAddressDeny=any` / `IPAddressAllow=localhost`,
  so a service cannot make outbound connections. Correct for the relay, which
  makes none; pass `--allow-egress` for one that does.
- **`MemoryMax=320M`** is a backstop, not a target — it turns a runaway into a
  restart rather than a kernel OOM that might take nginx or sshd with it. Lower it
  when the box has several services on it.

To ship to a new service from CI, copy the `deploy` job and change `SERVICE`. The
sudoers rule already covers it: CI is granted `ideate-service release *` and
nothing else, so a leaked deploy key cannot register or remove a service.

## Pipeline

Tag to release:

```sh
git tag relay-v3.1.0 && git push origin relay-v3.1.0
```

`verify` runs on every PR touching the relay or either half of the wire contract:
`go vet`, `go test -race`, the TypeScript frame fixtures, and a check that
`protocol.Version` and `PROTOCOL_VERSION` still agree. That last one exists
because the two ends refuse to talk on a mismatch, so a skew strands every user
until the app catches up.

`deploy` uploads the binary and calls `ideate-service release`, which installs
atomically, restarts, polls `/healthz`, and rolls back to the previous binary if
it does not come up. **A release severs every live tab WebSocket** — both ends
reconnect, and for Agent Link that costs each connected human one re-pair. There
is no way around it without two instances and a drain, which this box is too small
for and the feature is too interactive to benefit from.

### Repository configuration

Secrets (Settings → Secrets and variables → Actions):

| | |
| --- | --- |
| `DEPLOY_HOST` | droplet IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private half of `DEPLOY_PUBKEY` |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -H <droplet>` |

Variables:

| | |
| --- | --- |
| `RELAY_PUBLIC_URL` | `https://ideate-mcp.haru.lk` — optional; when set, the deploy job curls `/healthz` through Cloudflare afterwards, which is the only step that proves the whole path rather than just the process |

Create a `production` environment if you want a human to approve deploys.

## Operating

```sh
ideate-service list                      # what is on the box
journalctl -u ideate-relay -f            # structured JSON on stderr
curl -fsS https://ideate-mcp.haru.lk/v1/capacity
curl -fsS -u ops:<pw> https://ideate-mcp.haru.lk/v1/stats
```

Cloudflare's IP ranges are refreshed weekly by `ideate-cf-firewall.timer`. It
diffs against the last applied list, so a range Cloudflare drops actually stops
being allowed — and it refuses to apply a fetch returning fewer than ten ranges,
because acting on a truncated download would delete every allow rule and take the
origin offline.
