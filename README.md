# Switchboard

**A self-hosted control panel for your servers and websites.** Move a site from one server to another in one click, keep a standby server ready with fresh data, back up databases (also to S3), watch traffic and logs, get alerted when something looks wrong — and deploy with GitHub CI/CD.

Built for people who run apps (Laravel, Node/Nuxt, static sites…) in **Docker** on a few **VPS / home servers**, with their domains on **Cloudflare**.

> Nothing is installed on your servers to monitor them: Switchboard connects over **SSH** and uses `docker exec`.

```
                ┌──────────────── Switchboard (runs on its own small machine) ───────────────┐
                │  dashboard · health checks · backups · traffic · alerts · deploys · CI/CD   │
                └───────┬──────────────────────────┬──────────────────────────┬──────────────┘
                   SSH + docker exec          SSH + docker exec          Cloudflare API
                        │                          │                    (points your domain
               ┌────────▼────────┐        ┌────────▼────────┐            to the live server)
               │  Server A (live) │        │ Server B (standby)│
               │  app · mysql · … │  ───►  │  app · mysql · …  │   data copied on demand / on schedule
               └─────────────────┘        └──────────────────┘
```

---

## What you can do

| | |
|---|---|
| **Switch servers** | One click moves your domain to another server: maintenance mode → copy the database (and uploads) → health check → change Cloudflare DNS. Rolls back if a step fails. Optional **auto-failover** when the live server dies. |
| **Keep standbys fresh** | Copy data between servers any direction, on demand or on a schedule. See how old each copy is. |
| **Backups** | Scheduled + one-click database backups (MySQL, MariaDB, PostgreSQL). Restore into any server (with a safety backup first). Store them in **S3** (AWS, MinIO, Wasabi, R2, Spaces…). |
| **Monitoring** | Health checks every minute straight to each server, uptime bars, CPU/memory/disk, containers, SSL expiry, DNS drift. |
| **Traffic & logs** | Requests per minute, errors, top pages/IPs/bots from your nginx logs. Live log viewer (nginx, Laravel, containers, SSH logins). |
| **Alerts** | Telegram, Discord, Slack or any webhook: server down, failover, failed backup, disk full, **traffic spike / attack**, many 5xx errors, SSH brute force… |
| **Server control** | Restart / turn off a server, change user passwords, see every open port, change a container's port, **connect a domain to a port** in one step. |
| **Deploys & CI/CD** | Deploy button, or **GitHub Actions with self-hosted runners**: push → tests → deploy server by server. **Staging** copies and **pull-request previews**. |
| **New apps** | Start a new **Laravel / Node / static** app from a template: Docker, database, web proxy, DNS and a GitHub repo, set up for you. |
| **More** | Load balancing (own nginx or Cloudflare), shared database server, clone a whole server, OS upgrades, apps outside Docker (PM2, systemd), users with roles (admin / developer / viewer), 2FA, audit log. |

---

## Quick start (about 10 minutes)

### What you need
- **A machine to run Switchboard** with Docker installed — a small VPS (1 GB RAM is enough) or an always-on home computer. ⚠️ **Not one of the servers it manages**: if that server dies, your dashboard dies with it.
- **SSH access** from that machine to your servers. The SSH user must be able to run `docker` (root, a user in the `docker` group, or passwordless `sudo docker`).
- Your **domains on Cloudflare** (free plan is fine) — needed for switching servers and connecting domains.

### 1. Install

```bash
git clone https://github.com/limseang/server-monitoring.git switchboard
cd switchboard
cp .env.example .env              # optional settings (time zone, …)
docker compose up -d --build
docker logs switchboard           # shows a one-time setup code
```

### 2. Create your admin account
Open **http://YOUR-MACHINE-IP:8080**, enter the setup code from the logs, and choose a username and password.

### 3. Connect Cloudflare
**Settings → Cloudflare** → paste an API token → **Test**.
Create the token in Cloudflare → *My Profile → API Tokens → Create Token → "Edit zone DNS"* template (permissions `Zone · DNS · Edit` and `Zone · Zone · Read`).

### 4. Add your servers
**Servers → + Add server**: a name, the server's **public IP**, the SSH user and its private key → **Test connection**.

Tip — make a key just for Switchboard (run on the Switchboard machine, then paste the content of the `switchboard` file into the form):
```bash
ssh-keygen -t ed25519 -f switchboard -C switchboard
ssh-copy-id -i switchboard.pub root@SERVER_IP      # once per server
```

### 5. Add your website as a project
- **App already running on your servers?** Overview → **+ Existing app** → name, domain, health check (Laravel 11+: `/up`), pick its Cloudflare records. Then **+ Add a server to this project** for each server — Switchboard scans the server and fills in the containers and database for you → **Test database**.
- **New app?** Overview → **+ New app from template** and follow the steps.

Switchboard sees which server Cloudflare points to and marks it **LIVE**. Done! 🎉

### 6. (Recommended) Get alerts
**Settings → Alerts**: a Telegram bot token (from **@BotFather**) and your chat id (from **@userinfobot**) → **Send test message**.

---

## 🔒 Keep it safe — please read

Switchboard holds the keys to all your servers. Treat it like a password manager.

1. **Never publish the `data/` folder** (or any copy of it). It contains the database with your SSH keys, passwords and tokens, the key that decrypts them (`app.key`) and your database backups. It is in `.gitignore` — keep it that way, and don't commit copies like `data-backup/`.
2. **Don't expose port 8080 to the whole internet.** Best: put it behind HTTPS (Cloudflare Tunnel, Caddy or nginx) and set `COOKIE_SECURE=true` and `TRUST_PROXY=true` in `.env` — or keep it private (`"127.0.0.1:8080:8080"` in `docker-compose.yml`) and reach it through Tailscale or an SSH tunnel.
3. **Turn on 2FA** for every user (Settings → Your account).
4. **Give people the smallest role they need**: *developer* (deploy, logs, backups — no server/settings changes) or *viewer* (read-only).
5. **Back up `data/` somewhere private** (and turn on S3 backup storage for your database backups).
6. **Set your own `APP_KEY`** in `.env` (`openssl rand -base64 32`) if you prefer it outside the `data/` folder.

If a secret ever leaks: change the server passwords / SSH keys, database passwords and API tokens it contained, and make the repository private.

---

## Everyday use

| I want to… | Do this |
|---|---|
| Move my site to the other server | Project → **⇄ Switch server** (keep "Copy the database first" ticked). |
| Server A died, switch now | Same button — the standby serves its last copy (the dialog tells you how old). Or turn on **auto-failover** in project Settings. |
| Go back after a failover | **Switch server → A** with "Copy the database first" ticked (copies B → A first). |
| Refresh a standby | **Copy data** from live → standby, or set "Copy data automatically" in project Settings. |
| Restore a backup | Project → **Backups** → **Restore…** into any server. |
| See what's happening on a server | Servers → a server → **Traffic** and **Logs** tabs. |
| Point a subdomain at an app | Servers → a server → **Connect domain** (or Ports & domains tab). |
| Deploy | Server card → **Deploy**, or push to GitHub when CI/CD is set up. |

**Good to know**
- Use **proxied (orange cloud)** DNS records — then a switch takes effect in seconds.
- Use the same SSL setup on all servers (e.g. one Cloudflare Origin Certificate, SSL mode "Full (strict)").
- If your servers only accept Cloudflare IPs on 80/443, also allow the Switchboard machine's IP (health checks go straight to each server).
- Only one server should be live at a time; standbys get a copy of the data.
- A server with a **private IP** (home Wi-Fi `192.168.x.x`, cloud-internal `10.x.x.x`) can't receive visitors — set its public IP (and keep the private one as "SSH host"). Switchboard refuses to point DNS at a private IP.

---

## Feature guides

<details>
<summary><b>Backups in S3</b></summary>

**Settings → Backup storage (S3)**: endpoint, bucket, access key, secret key, region, a folder name, and the address style (*path style* for MinIO and most S3-compatible storage, *virtual host* for AWS) → **Test** → **Save** → **Upload existing backups**.

Every backup is uploaded right after it's made; the local copy is removed about 30 minutes later (tick "Also keep a copy on this machine" to keep both). Restore and Download fetch from S3 automatically. Failed uploads are retried every 10 minutes and alerted. The keys are stored encrypted and never shown again.
</details>

<details>
<summary><b>GitHub CI/CD (self-hosted runners), staging and PR previews</b></summary>

1. **Settings → GitHub**: a token → **Test**. Classic token with scopes `repo` + `workflow`, or a fine-grained token with *Administration, Contents, Workflows, Actions* (read & write) and *Pull requests* (read).
2. Project → **CI/CD** tab → repository (`owner/name`) and live branch → **Set up CI/CD**.
3. Push to the live branch: tests run on GitHub's machines, then the runner on each of your servers deploys that exact commit — standby servers first, the live one last, with a health check after each.

- The runner runs as user `sb-runner` and may only run Switchboard's deploy/preview commands.
- Your servers only need **outgoing** access to GitHub; nothing has to reach them or Switchboard from outside.
- **Staging**: CI/CD tab → *+ Add staging* (own branch, address and database; "Copy live data" anytime).
- **Pull request previews**: choose a preview server and domain; every PR gets `pr-<number>-<project>.<domain>`, removed when the PR closes.
- Files Switchboard puts on a server: `/usr/local/bin/switchboard-helper`, `/etc/switchboard/`, `/opt/switchboard-runner/`, `/etc/sudoers.d/switchboard-runner`; template apps in `/srv/<project>`.
</details>

<details>
<summary><b>Traffic, logs and unusual-activity alerts</b></summary>

Switchboard reads what's new in each server's nginx access logs every minute (standard "combined" log format). The **Traffic** tab shows requests/min by status, error rate, visitors, top pages, IPs and bots. Alerts fire on: traffic spike (5× usual), traffic drop on a live server, ≥5 % server errors, one IP making ≥40 % of requests, ≥50 failed SSH logins in 5 minutes — limits in **Settings → Monitoring**. The **Logs** tab is a live viewer with a filter (admins and developers only).
</details>

<details>
<summary><b>Server control: power, passwords, ports, domains</b></summary>

Servers → a server:
- **Power ▾**: Restart, Force restart, Turn off (type the server name to confirm; refused for a live server unless you confirm). Turning a server back **on** needs your provider's panel.
- **Power & access → Change a password** for any user (with a generator).
- **Ports & domains**: every open port and what's behind it. **Port** changes a Docker Compose container's published port (backup kept, rolled back on failure). **Connect domain** creates the Cloudflare record + web-proxy site for any app in one step.
</details>

<details>
<summary><b>Load balancing, shared database, clone, OS upgrade</b></summary>

- **Load balancing** (project → Traffic tab): your own nginx load balancer or Cloudflare Load Balancing; zero-downtime switches and rolling deploys.
- **Shared database server**: MySQL / MariaDB / PostgreSQL + Redis on one server, reachable only by your app servers.
- **Clone a server** (server → Clone): Docker, images, compose stacks with volumes and databases, host setup (packages, users, cron, nginx, certificates, firewall…). "Scan" shows what will be copied first.
- **Upgrade OS**: Ubuntu LTS / Debian, one release at a time, containers restarted and health-checked afterwards.
</details>

<details>
<summary><b>Users and roles</b></summary>

Settings → Users: **admin** (everything), **developer** (deploy, logs, maintenance, backups, app-container commands, CI runs, staging data, previews), **viewer** (read-only, no logs or backup downloads). Every action is in the Activity log.
</details>

---

## Updating

```bash
cd switchboard
git pull
docker compose up -d --build      # your data in ./data is kept; database changes apply automatically
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Lost the setup code | `docker logs switchboard` (it's printed at every start until an admin exists). |
| Locked out | `docker exec -it switchboard node src/cli.js reset-password USER NEW-PASSWORD` (also `disable-2fa USER`). |
| "SSH host key CHANGED" | Rebuilt the server? Server → More → Reset SSH host key. Otherwise investigate! |
| "authentication failed" | Wrong user/key — try `ssh -i key user@ip` from the Switchboard machine. |
| `permission denied … docker.sock` | Add the SSH user to the `docker` group, or set Docker command to `sudo docker` on the server. |
| DB "Access denied" | Set the DB user/password on the project's server card (⋯ → Edit containers / database). |
| Health check fails but the site works | Check scheme/port/path in project Settings and your firewall (allow the Switchboard machine). |
| Switch stops at `php: command not found` | Set the **App container** on the server card (⋯ → Edit containers / database). |
| Server shows Down but is running | "Down" means the *website* doesn't answer on the server's IP. Check ports 80/443 at your provider's firewall / port forwarding. |

## Development & test lab

Needs Node.js 22.13+ (or just Docker).

```bash
npm install
npm run dev                          # http://localhost:8080, data in ./data
```

The `dev/` folder has a complete **test lab** — fake servers, fake Cloudflare, fake GitHub and an S3 server — so you can try everything without touching real servers:

```bash
./dev/setup.sh                       # starts the lab → http://localhost:8090 (admin / admin-password-123)
node dev/e2e.mjs                     # switch, copy, backup/restore, failover, alerts, deploy
node dev/e2e-extra.mjs               # PostgreSQL, MariaDB, failed import rollback
./dev/clone-setup.sh && node dev/e2e-clone.mjs   # clone a server (also e2e-lb.mjs, e2e-os.mjs)
./dev/ci-setup.sh && node dev/e2e-ci.mjs         # templates, CI/CD, staging, previews (also e2e-server.mjs, e2e-traffic.mjs)
docker compose -f dev/docker-compose.yml --profile s3 up -d s3 && node dev/e2e-s3.mjs   # S3 backups
docker compose -f dev/docker-compose.yml down -v # remove the lab
```

The lab needs about 6 GB of memory for Docker when everything runs at once.

Environment variables: `PORT`, `DATA_DIR`, `APP_KEY`, `TZ`, `ADMIN_USER`, `ADMIN_PASSWORD`, `COOKIE_SECURE`, `TRUST_PROXY`, `SESSION_DAYS`.
