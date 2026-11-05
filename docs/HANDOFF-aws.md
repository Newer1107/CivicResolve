# CivicResolve — hosting handoff (AWS EC2)

Written 2026-11-05. CivicResolve runs on a single AWS EC2 instance. The home box runs nothing
civic-related; deb2 is stopped but intact (rollback). `civic.raunaktech.site` and the Meta
webhook URL did not change during any of these moves.

---

## 1. Where everything lives

| Piece | Path / address |
|---|---|
| Host | AWS EC2, `13.202.25.24`, Ubuntu 26.04, 2 vCPU, 3.8 GB RAM, 28 GB disk |
| SSH | `ssh -i ~/.ssh/keys/civicresolve.pem ubuntu@13.202.25.24` (key: `CivicResolve.pem`) |
| Portal (Next.js 15.2.4) | `/opt/civicresolve/app` → `:3111` |
| WhatsApp bridge (Express) | `/opt/civicresolve/whatsapp` → `:3320` |
| Docs site (static) | `/opt/civicresolve/site` → `:8099` |
| MySQL 8.0 | docker `civic-mysql` → `127.0.0.1:3307` |
| Redis 7 | docker `civic-redis` → `127.0.0.1:6379` |
| Edge | cloudflared systemd service, tunnel `2a08f027-4507-4126-981c-f9f7fbb03b00` |
| Compose | `/opt/civicresolve/docker-compose.yml` |

Everything except the Cloudflare tunnel binds **127.0.0.1**. The security group only needs 22;
the tunnel is outbound-only.

Node is at `/opt/node22` (v22.22.1) — not the distro package.

---

## 2. Services

| Unit | User | Command | Port |
|---|---|---|---|
| `civic-app` | ubuntu | `next start -p 3111 -H 127.0.0.1` | 3111 |
| `civic-whatsapp` | ubuntu | `node src/index.js` | 3320 (loopback) |
| `civic-site` | ubuntu | `python3 -m http.server 8099` | 8099 |
| `cloudflared` | root | tunnel `2a08f027…`, config `/etc/cloudflared/config.yml` | — |

All `Restart=always`, all enabled at boot. `ubuntu` has passwordless sudo.

```bash
ssh -i ~/.ssh/keys/civicresolve.pem ubuntu@13.202.25.24
sudo systemctl status civic-app civic-whatsapp civic-site cloudflared
sudo systemctl restart civic-app
sudo journalctl -u civic-app -n 50 --no-pager
```

---

## 3. Data

- Database `civicresolve_dev` inside `civic-mysql`; root password = `DB_PASSWORD` in `/opt/civicresolve/.env`.
- State at cutover: **20 issues, 34 users, 41 updates, 19 wa_messages, 1 merged duplicate** (issue 22 → 17).
- Uploads: `/opt/civicresolve/app/public/uploads/` (~9 MB, gitignored — copy it by hand on any rebuild).

```bash
# backup
docker exec civic-mysql sh -lc 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick civicresolve_dev' | gzip > civic-$(date +%F).sql.gz
# restore
gunzip -c civic-YYYY-MM-DD.sql.gz | docker exec -i civic-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" civicresolve_dev'
```

**No cron backup exists yet.** Outstanding.

Helper on the box: `/tmp/counts.sh` prints `issues users updates wa dups` (recreate it if wiped).

---

## 4. Config & secrets

chmod 600, never printed:

| File | Holds |
|---|---|
| `/opt/civicresolve/.env` | DB creds for compose |
| `/opt/civicresolve/app/.env` | portal env: DB, Redis, JWT, DeepSeek, email, feature flags, `BRIDGE_URL`/`BRIDGE_API_KEY` |
| `/opt/civicresolve/whatsapp/.env` | bridge env: `DATABASE_URL`, WhatsApp token/app secret/phone id/verify token, DeepSeek, bridge key |
| `~/.cloudflared/cert.pem` + `2a08f027….json` | Cloudflare tunnel cert; config copy in `/etc/cloudflared/` |
| `~/.gh_token`, `~/.git-credentials` | GitHub read access for the private bridge repo |

**Rotate the DeepSeek key after the demo** — it was pasted in chat during development.

---

## 5. Edge / DNS

- Tunnel **`2a08f027-4507-4126-981c-f9f7fbb03b00`** (`civic-aws`), `protocol: http2`, config `/etc/cloudflared/config.yml`.
- CNAMEs → this tunnel: `civic.raunaktech.site`, `civicresolve.raunaktech.site`, plus `civic-aws.raunaktech.site` (test host).
- Earlier tunnels, both still registered but with no DNS pointing at them: `df3ec594…` (deb2), `be491a70` (home box). Delete them in the dashboard once rollback is off the table.
- Re-route if a record is lost:
  ```bash
  cloudflared tunnel route dns --overwrite-dns civic-aws civic.raunaktech.site
  ```

Ingress order matters — the path rule must be first:

```yaml
ingress:
  - hostname: civic.raunaktech.site
    path: ^/webhook/whatsapp
    service: http://127.0.0.1:3320
  - hostname: civic.raunaktech.site
    service: http://127.0.0.1:3111
  - hostname: civicresolve.raunaktech.site
    service: http://127.0.0.1:8099
  - hostname: civic-aws.raunaktech.site
    service: http://127.0.0.1:3111
  - service: http_status:404
```

---

## 6. WhatsApp / Meta

Unchanged by the move — the callback URL is still
`https://civic.raunaktech.site/webhook/whatsapp`, so nothing had to be touched in the Meta console.

- App **CivicResolve Demo** `1455467770016032`, business `1348404383590131`
- WABA `1155254556919783`, phone number ID `1354165821123398`, display **+1 555 153 4991**
- System user `civicresolve`, `SYSTEM_USER` token, `expires_at: 0`, messaging + management scopes, app and WABA assets assigned
- Allow-listed recipient `+91 9372499047` — still a Meta **test** number, so only allow-listed numbers can message it. A production number is needed for a jury demo.

**Do not touch:** system user `automationadmin`, app-level callback `ba85aab5-7cd2-4506-8195-701e48c1a18f`, or the 711 phone number ID — the hotel bot shares that Meta business.

---

## 7. Deploying a change

```bash
ssh -i ~/.ssh/keys/civicresolve.pem ubuntu@13.202.25.24
cd /opt/civicresolve/app          # or whatsapp
git pull
/opt/node22/bin/npm install --legacy-peer-deps   # only when deps change
/opt/node22/bin/npm run build                     # ~90 s
sudo systemctl restart civic-app                  # or civic-whatsapp
```

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://civic.raunaktech.site/         # 200
curl -s -o /dev/null -w '%{http_code}\n' https://civicresolve.raunaktech.site/  # 200
curl -s http://127.0.0.1:3320/api/health                                        # bridge
```

A failed build leaves the previous `.next` gone — build first, restart only on success. The build
needs ~1.5 GB free RAM; the box has 3.8 GB, so a build while the portal is running is fine.

---

## 8. Traps hit during these migrations

1. **`mysql2` must stay pinned to 3.19.0.** 3.24+ imports `node:diagnostics_channel`, which Next's webpack refuses (`UnhandledSchemeError`). The pin is in `package.json`.
2. **npm 10.9.4 and 9.2.0 both crash with `Cannot read properties of null (reading 'edgesOut')`** on the `vitest@4.1.12` peer set. `--legacy-peer-deps` gets around it. On a cold install, drop `vitest`/`@vitest/*` from devDependencies, install, then restore `package.json`.
3. **`output: 'standalone'` was tried and reverted.** With standalone output `next start` refuses to run and you must ship `.next/standalone` + `public` + `.next/static` separately; the standalone `node_modules` are symlinks, so `rsync -a` between hosts that share the same path produces a self-referential loop. Plain `next start` is what runs now.
4. **The bridge's `prisma/schema.prisma` used to be an absolute symlink** into the old home dir, breaking every clone. Now a real file (commit `628e44f`) — re-copy it when the portal schema changes.
5. **The bridge binds loopback by default** (`HOST` env, default `127.0.0.1`). Only cloudflared talks to it.
6. **Two boxes answering the same hostname** is the failure mode to avoid: old units are stopped *and* disabled, not just stopped.
7. `mysqladmin ping` healthcheck can read `unhealthy` while MySQL is still initialising; wait for `ready for connections` in `docker logs civic-mysql` before importing a dump.

---

## 9. Rollback

deb2 still has code, data and credentials; its units are disabled.

```bash
ssh root@100.92.91.114 'systemctl enable --now civic-app civic-whatsapp civic-site cloudflared'
ssh root@100.92.91.114 'cloudflared tunnel --origincert /root/.cloudflared/cert.pem route dns --overwrite-dns civic-deb2 civic.raunaktech.site'
# then disable on AWS:
sudo systemctl disable --now civic-app civic-whatsapp civic-site cloudflared
```

deb2's MySQL holds the same data as of the cutover; anything written on AWS afterwards would have
to be dumped and restored back.

---

## 10. Open items

- **No scheduled backups** (DB + uploads) on either host.
- **Meta test number** — production number needed for the jury demo.
- **Docs site is stale**: `/system.html` and the landing page still name **CoE** as the AI provider; the app moved to DeepSeek in `e81e50f`.
- **DeepSeek key rotation** after the demo.
- `civic-verify.timer` (AI verification worker) was never migrated — verification runs on demand only.
- Challenge deck still needs re-export to PDF.
