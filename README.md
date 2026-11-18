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
| **Alerts** | Telegram, Discord, Slack or any webhook: server down, failover, failed backup, disk full, finished jobs you pick (deploy, clone…), **traffic spike / attack**, many 5xx errors, SSH brute force… |
| **Server control** | Restart / turn off a server, change user passwords, see every open port, change a container's port, **connect a domain to a port** in one step. **Clean up / free memory** in one click (or weekly). |
| **Deploys & CI/CD** | Deploy button, or **GitHub Actions with self-hosted runners**: push → tests → deploy server by server. **Staging** copies and **pull-request previews**. |
| **New apps** | Start a new **Laravel / Node / static** app from a template: Docker, database, web proxy, DNS and a GitHub repo, set up for you. |
| **Database for other services** | Another app (a media server, a worker…) can use a project's database through **one name** like `db.example.com` that always points to the live server — switching servers never breaks it. Only the IPs you allow can connect, and only to the live server. |
| **Server bills** | Remember when each rented server must be paid (DigitalOcean, Hetzner, Vultr, home…): price, every 1/3/6/12 months, a one-click link to the provider's billing page, **reminders before the due date** (never twice), "Mark as paid" with payment history, and your total cost per month. |
| **More** | Load balancing (own nginx or Cloudflare), shared database server, clone a whole server or copy one project to another server (on other ports if you like), OS upgrades, apps outside Docker (PM2, systemd), users with roles (admin / developer / viewer), 2FA, audit log. |

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
Create the token in Cloudflare → *My Profile → API Tokens → Create Token → "Edit zone DNS"* template (permissions `Zone · DNS · Edit` and `Zone · Zone · Read`). To set the SSL mode from Switchboard, also add `Zone · Zone Settings · Edit`; to install Cloudflare Origin Certificates, `Zone · SSL and Certificates · Edit`.

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

### Deploy one of your GitHub repos (also to a home server)

1. **Settings → GitHub**: paste a token → **Test** (see the CI/CD guide below for the permissions).
2. Overview → **+ Deploy from my GitHub** → pick the repository from the list. Switchboard looks at it and picks the type: a repo with its **own `docker-compose.yml`** (like this project), Laravel, Node or a static site. For a compose repo, check the port it listens on.
3. Choose the server(s). A domain is optional — on a **home server** just leave it empty and open `http://SERVER-IP:PORT` on your network.
4. Keep **"Switchboard deploys"** selected → **Create and deploy**.

From then on, every push to that branch is deployed by itself within a minute (after its tests pass on GitHub, if you add tests in the CI/CD tab). Nothing is installed on the server for this and nothing has to reach it from the internet — Switchboard only needs to reach the server over SSH. Only commits that are really on the branch are ever deployed.

### 6. (Recommended) Get alerts
**Settings → Alerts**: create a bot with **@BotFather** (`/newbot`), open your bot in Telegram and press **Start** (a bot can only message people who wrote to it first — for a group, add the bot to it), paste the token, click **Find my chat id**, then **Save** and **Send test message**. Tick **Message me when these jobs finish** (deploy, clone, backup…) to get the result of each job — or only failures.

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
| Run a project on another server too | Project → server card **⋯** → **Copy to another server…** (or Servers → a server → **More → Copy a project to another server…**). Pick the server and, if you like, new ports. **Check both servers** shows what will be copied first. |
| Delete a broken container (e.g. one stuck restarting) | Servers → a server → **Containers** tab → **Delete** (type its name to confirm). Data volumes are kept; a live project's app/database container is refused. A compose container comes back on the next `docker compose up` / Deploy — take it out of `docker-compose.yml` to remove it for good. |
| Take a project off one server | Project → server card **⋯** → **Remove from project…** → "Also delete it from the server" (backs up the database first). |
| Delete a project for good | Project → Settings → **Delete project** → "Also delete it from all servers". A final DB backup is kept in `backups/_deleted/`. |
| Clean a server but keep its OS | Servers → a server → **More → Reset server…**. **Scan** shows what will be deleted first. |
| Rebuild a server from zero (erase the whole disk) | Servers → a server → **More → Reinstall OS…**: fresh Debian/Ubuntu, same IP, login root with the same key/password, Docker installed. |

**Good to know**
- Use **proxied (orange cloud)** DNS records — then a switch takes effect in seconds.
- Use the same SSL setup on all servers (e.g. one Cloudflare Origin Certificate, SSL mode "Full (strict)").
- **Project → Settings → Cloudflare DNS records** can also point one record at another IP (one of the project's servers or any other, e.g. an old server), turn the proxy on/off, and set the zone's SSL mode. **Full** is the safe default (Switchboard's web proxy has a self-signed certificate). Avoid **Flexible**: if the server redirects http → https, visitors get an endless redirect loop. Before changing the mode, Switchboard checks every proxied hostname of the zone and refuses a change that would break one (you can still force it). Admins only; every change is in the activity log.
- For **Full (strict)**: the same card has **Install Origin Certificate**. Each server makes its own key, Cloudflare signs a 15-year certificate for the zone (and `*.zone`), and Switchboard's web proxy uses it right away. On a server where your own nginx serves the site, the files are saved in `/etc/ssl/cloudflare/` and the job log shows the two nginx lines to add. Tick "Then switch SSL to Full (strict)" to switch in the same step (only if every hostname passes).
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
2. Project → **CI/CD** tab → repository (`owner/name`), live branch and how commits get to your servers → **Set up CI/CD**:
   - **Switchboard deploys** (recommended): every minute Switchboard checks the branch and deploys a new commit over SSH — after its tests pass, if you have tests. No runner, works behind NAT (home servers) and is safe for **public repos**.
   - **GitHub runner on each server**: deploys right after the tests, and is needed for pull-request previews. ⚠️ On a **public** repo, a self-hosted runner can be targeted by strangers' pull requests — use the first mode, or require approval for outside contributors (GitHub → Settings → Actions).
3. Push to the live branch: the commit is deployed to each server — standby servers first, the live one last, with a health check after each. A commit that is not on the branch (e.g. from a pull request) is always refused.

- The runner runs as user `sb-runner` and may only run Switchboard's deploy/preview commands.
- Your servers only need **outgoing** access to GitHub; nothing has to reach them or Switchboard from outside.
- **Staging**: CI/CD tab → *+ Add staging* (own branch, address and database; "Copy live data" anytime).
- **Pull request previews**: choose a preview server and domain; every PR gets `pr-<number>-<project>.<domain>`, removed when the PR closes.
- Files Switchboard puts on a server: `/usr/local/bin/switchboard-helper`, `/etc/switchboard/`, `/opt/switchboard-runner/`, `/etc/sudoers.d/switchboard-runner`; template apps in `/srv/<project>` by default — or any folder you pick (or create) with **Browse…** in the New app dialog.
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
<summary><b>Clean up a server / free memory (make it faster)</b></summary>

When a server gets slow or its disk fills up, old Docker leftovers and logs are usually the cause. Switchboard can clear them for you — **without touching your data**.

1. Servers → your server → **More ▾ → Clean up / free memory…** (admins only). When an alert says *disk is 90 % full*, clicking the alert opens the same window.
2. Switchboard looks at the server first (this changes nothing) and shows how much each part would free:
   - **Docker**: build cache, dangling images (old layers without a name), stopped containers, unused networks. **Volumes (your databases) are never removed**, running containers keep running, and stopped containers that belong to one of your projects are kept.
   - **Extra: all unused images** — frees the most, but older versions you might roll back to must be downloaded/built again. Off by default.
   - **System**: old journal logs (keeps the last 7 days), downloaded package files (`apt-get clean`), and log files of 20 MB or more in `/var/log`, Docker's container logs and your Laravel apps' `storage/logs`. Log files are **emptied, not deleted**, so apps keep writing to them.
   - **Laravel**: `php artisan optimize:clear` in the app container of each project on the server; apps that were optimized get `php artisan optimize` again right after, so they stay fast. This also empties the app cache.
   - **Memory**: restart a container that uses too much memory (the top ones are listed with their memory use; the app is offline for a few seconds), move swap back into memory (only when enough RAM is free), or drop the page cache. *Honest note:* the page cache is Linux keeping recently read files in spare memory — it is given back by itself when an app needs it and fills up again quickly, so dropping it rarely makes anything faster.
3. Tick what you want → **Clean up now**. The job log shows disk and memory **before and after**, and how much each step freed.
4. **Weekly cleanup** (same window): pick a day and time → **Turn on weekly cleanup**. It runs the parts that are ticked at that moment, never a container restart. **Turn off** to stop it.
</details>

<details>
<summary><b>Load balancing, shared database, clone, OS upgrade</b></summary>

- **Load balancing** (project → Traffic tab): your own nginx load balancer or Cloudflare Load Balancing; zero-downtime switches and rolling deploys.
- **Shared database server**: MySQL / MariaDB / PostgreSQL + Redis on one server, reachable only by your app servers.
- **Clone a server** (server → Clone): Docker, images, compose stacks with volumes and databases, host setup (packages, users, cron, nginx, certificates, firewall…). "Scan" shows what will be copied first — with a tick box for every Docker project and every app folder outside Docker, so you can copy **all or only some** of them (All / None). Only the picked projects get the new server as a standby. Host setup (nginx, cron…) is still copied as a whole.
- **Copy one project to another server** (project → server card ⋯ → Copy to another server, or server → More): only that project — its Docker Compose stack (folder, exact images, volumes with the database, paused while copied for an exact snapshot) and/or its apps outside Docker (PM2 apps, systemd services, its nginx server blocks, the app folder, the user that runs it and its Node.js). Each port the project uses is listed: keep it, or type a new one. A port already used on the target (or 22) is refused. A new port is written into the copied `docker-compose.yml` / `.env`, the PM2 env (`PORT`) or systemd `Environment=`, nginx `proxy_pass`/`listen` and Switchboard's web proxy site, so the copy really runs there. The target is then added to the project as a standby (traffic is not moved). Nothing on the target is overwritten unless you tick **Replace**. Note: the project's health check uses one port for every server — if you change that port, check through the domain (port 80/443) instead.
- **Upgrade OS**: Ubuntu LTS / Debian, one release at a time, containers restarted and health-checked afterwards.
- **Reset a server** (server → More → Reset server): deletes every container, volume, image and compose folder, plus (optional) PM2/systemd apps, nginx sites and crontabs, GitHub runners and Switchboard's files. Keeps the OS, users, SSH and Docker, and saves the old configs to `/root/switchboard-reset-<date>.tar.gz`. Refused while the server is live for a project, a load balancer, a database server, or runs Switchboard itself.
- **Reinstall OS** (server → More → Reinstall OS): erases the **whole disk** and installs a fresh Debian 12/13 or Ubuntu 22.04/24.04/26.04 over SSH, on any provider (DigitalOcean, AWS, home servers). Uses the open-source [bin456789/reinstall](https://github.com/bin456789/reinstall) tool pinned to one commit (`REINSTALL_REF` to change it). Afterwards: user root with the same SSH key or password, same SSH port, new host key pinned, Docker installed. Takes 5–20 minutes. If it is cancelled before the reboot, the prepared installer is cancelled again. If the installer can't bring the network up (rare), you need the provider's web console (or a screen and keyboard for a home server) — try it on a spare server first.
</details>

<details>
<summary><b>Let another service use a project's database (e.g. a media server)</b></summary>

If another app connects **straight to the database** (its `.env` has `DB_HOST=` an IP of your server), it breaks every time you switch servers. Give it one name that follows the live server instead:

1. Open the project → **Database access** tab → **Turn on…**
2. **Host name**: keep the suggestion (`db.yourdomain.com`) or type another one. Switchboard creates it in Cloudflare as **DNS only** (grey cloud — a database can't go through Cloudflare's proxy), with a 60-second TTL, and links it to the project so it moves with every switch.
3. **Port**: 3306 for MySQL, 5432 for PostgreSQL (pick another one if that port is already taken on a server).
4. **Who may connect**: the public IPv4 of the other server (run `curl -4 ifconfig.me` on it). You can add several, or a range like `203.0.113.0/24`.
5. **Save and set up on all servers.** Then copy the shown settings into the other service's `.env`:
   ```
   DB_HOST=db.yourdomain.com
   DB_PORT=3306
   ```
   (Laravel: `php artisan config:clear` afterwards.)

How it works and what it protects:

- On every server of the project, a tiny proxy container (`sb-dbaccess-<id>`, image `alpine/socat`) publishes the database on the port. Your `docker-compose.yml` is not changed.
- If your database container **already publishes its port** (e.g. `ports: ["3306:3306"]` — then it is open to the whole internet!), Switchboard uses that port instead of a proxy and puts the firewall on it. Set the same port in the tab; a different one is refused with a message telling you which port to use. The port is closed over IPv6 too.
- A firewall allow-list (iptables `DOCKER-USER`, because Docker ignores ufw) lets **only your IPs** in. Your own containers still reach the database as before.
- **Only the live server is open.** Standbys are closed, so the other service can never write into a database that is about to be overwritten.
- **When you switch with a database copy**, the old server is closed **before** the copy starts, so nothing written from outside gets lost; after DNS moves, the new server opens. Your other service gets a few seconds of "can't connect" during the switch — Laravel retries on the next request. Run `php artisan queue:restart` there after a switch so long-running workers connect to the new server.
- Rules come back after a reboot. If your provider has its own firewall (DigitalOcean Cloud Firewall, AWS security group…), allow the port there too, from the same IPs.
- If something doesn't match (e.g. you marked another server as live by hand, or added a server to the project), the Overview tells you — press **Apply again**.
- **Turn off** removes the proxy, the firewall rules and (if Switchboard created it) the DNS record from every server.

Not for load-balanced projects or projects on a shared database server — that server has its own allow-list.
</details>

<details>
<summary><b>Server bills and payment reminders</b></summary>

So you never pay a server late:

1. Open a server → **Billing** → **+ Add billing info**.
2. Pick the provider (DigitalOcean, Hetzner, Vultr, Linode, AWS, Google Cloud, Azure, Contabo, OVH, Scaleway, Home, or *Other*). The link to its billing page is filled in for you — change it to your own panel link if you like.
3. Enter the **price**, the **currency** and how often you pay (every month, 3, 6, 12 months, or a custom number of months).
4. Enter the **next payment date** (the day you are paid until). Tick **Renews automatically** if the provider charges your card by itself.
5. **Save.**

What happens then:

- You get a Telegram / webhook message **7, 3, 1 and 0 days before** the due date (change the days in **Settings → Alerts → Payment reminders**). Each reminder is sent **once** — even after Switchboard restarts. Messages are not sent before 9:00 (also a setting; uses the `TZ` time zone).
- If the date passes, you get an **OVERDUE** message every day (or once — a setting) until you mark it as paid.
- **Renews automatically**: just one heads-up ("check your card has money"); when the day passes, the date moves forward by itself and the payment is recorded as *auto-renew*.
- After paying, click **Mark as paid**: the next payment date moves forward by one billing period (or the months you enter), and the payment goes into the history (date, amount, period, who, note). Deleted a payment by mistake? Deleting the latest payment puts the date back.
- **Open <provider> ↗** opens the provider's billing page in a new tab.
- The **Billing** page (left menu) lists every server with its next payment, the **total cost per month per currency**, and all payments. The Overview shows **Upcoming payments**, and payments due in 3 days or overdue appear in the problems list. Server cards get a 💳 *due in 3d* badge.

Only admins can change billing info or mark payments; developers and viewers can look.
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
| `Could not reach Telegram (EAI_AGAIN)` / `EAI_AGAIN github.com` | The container can't look up names (DNS) — common on home servers. Update to the latest `docker-compose.yml` (it sets DNS servers 1.1.1.1 / 8.8.8.8; change them with `DNS_1` / `DNS_2` in `.env`) and run `docker compose up -d`. Check with `docker exec switchboard node -e "require('dns').lookup('api.telegram.org',console.log)"`. |
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
./dev/clone-setup.sh && node dev/e2e-clone.mjs   # clone a server (also e2e-clone-pick.mjs, e2e-copy-project.mjs, e2e-lb.mjs, e2e-os.mjs, e2e-wipe.mjs, e2e-reinstall.mjs, e2e-cleanup.mjs)
./dev/ci-setup.sh && node dev/e2e-ci.mjs         # templates, CI/CD, staging, previews (also e2e-server.mjs, e2e-traffic.mjs)
docker compose -f dev/docker-compose.yml --profile s3 up -d s3 && node dev/e2e-s3.mjs   # S3 backups
docker compose -f dev/docker-compose.yml down -v # remove the lab
```

Tests that don't need the lab:

```bash
npm test                             # unit tests (billing dates and reminders)
node dev/cf-mock/server.js &         # fake Telegram on :8787, then run a Switchboard that uses it:
DATA_DIR=/tmp/sb-test PORT=8093 ADMIN_USER=admin ADMIN_PASSWORD=admin-password-123 TELEGRAM_API_BASE=http://127.0.0.1:8787 node src/index.js &
SB_URL=http://localhost:8093 node dev/e2e-billing.mjs   # server bills, reminders, mark as paid
```

`dev/e2e-dnsedit.mjs` tests changing a record's IP / proxy and the SSL mode from the project settings, `dev/e2e-origincert.mjs` the Origin Certificate on vps-ci / vps-new (`SB_URL`, `CF_URL`, `SB_KEY_FILE` — see their first lines).

`dev/e2e-dbaccess.mjs` tests "Database access" on the clone pair (vps-src / vps-new) — see its first lines for how to start a test Switchboard on the lab network.

The lab needs about 6 GB of memory for Docker when everything runs at once.

Environment variables: `PORT`, `DATA_DIR`, `APP_KEY`, `TZ`, `ADMIN_USER`, `ADMIN_PASSWORD`, `COOKIE_SECURE`, `TRUST_PROXY`, `SESSION_DAYS`.
