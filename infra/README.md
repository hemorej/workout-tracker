# infra — sprocket.jerome-arfouche.ca

Production runs on the shared DigitalOcean droplet described in
`~/Code/util/infra/` (OS, nginx globals, backups, restore). This directory is
everything specific to this app. Facts as of 2026-10-23.

## Where it lives

| | |
|---|---|
| Domain | `sprocket.jerome-arfouche.ca` (`www.` → apex, port 80 → https) |
| Stack | Nuxt 4 / Nitro (`node server/index.mjs`) behind nginx, PostgreSQL (`sprocketdb`) |
| Process | supervisor program `daemon-912439`, `user=forge`, **port 8000**, log `/home/forge/.forge/daemon-912439.log` |
| Site root | `/home/forge/sprocket.jerome-arfouche.ca/current/` → `releases/<id>/`, 4 releases kept (Forge setting); nginx serves `current/.output/public` and proxies the rest to `0.0.0.0:8000` |
| Forge site id | `3264841` |
| TLS | Let's Encrypt via Forge, renewed Sat 11:44 (`/root/.letsencrypt-renew/3562617`) |
| Node | 26.x (`package.json` engines, CI, and the server's v26.12.1) |

## Files here

| File | Purpose | Applied how |
|---|---|---|
| `forge_deploy.sh` | The deploy script — identical to the one in Forge's *Deploy Script* box | Keep the two in step by hand (it isn't on the server, so `snapshot.sh` can't check it) |
| `nginx.conf` | The vhost (`/etc/nginx/sites-available/sprocket.jerome-arfouche.ca`) | By hand; `./snapshot.sh` flags drift |
| `supervisord.conf` | The Nitro daemon (`/etc/supervisor/conf.d/daemon-912439.conf`) | Created by Forge's *Daemons* page; `./snapshot.sh` flags drift |
| `postgres.sql` | One-time role/database grants (run as `postgres`; set the password) | By hand |
| `forge-conf/` | Forge-generated includes, read-only reference. `site.conf` holds the `proxy_pass http://0.0.0.0:8000`, headers and the `.`-file deny rule | Refreshed by `./snapshot.sh` |
| `zwift-sync.plist.example`, `zwift-activities.plist.example` | launchd agents for the two **Mac-side** Zwift daemons that call this server | Copied to `~/Library/LaunchAgents/` (not on the droplet) |
| `crontab` | The Forge Scheduler jobs, written as crontab lines. Documentation only — nothing installs it | Recreate on the droplet when leaving Forge |
| `env.example` | Names of the variables in the server-side `.env` | — |
| `manifest`, `snapshot.sh` | What to compare with the server, and the script | `./snapshot.sh` |

## Server layout

```
/home/forge/sprocket.jerome-arfouche.ca/
  .env                       read by the supervisor program (`set -a; source .env`) — see env.example
  storage/
    fit-files/               raw FIT files from the Wahoo webhook (NUXT_FIT_STORAGE_DIR, absolute path)
    zwift-archive/
  current -> releases/<id>
  releases/<id>/
    .env -> ../../.env
    storage/fit-files -> ../../storage/fit-files     (Forge "linked directory" setting, not created by forge_deploy.sh)
    .output/                 self-contained Nitro bundle; node_modules and .nuxt are deleted after the build
```

Nothing from the volume is used. Changing a variable in `.env` needs
`sudo supervisorctl restart daemon-912439:daemon-912439_00`.

## Deploy

1. Push to `main` → `deploy` job in `.github/workflows/ci.yml` (after `checks`, environment `production`) calls
   the Forge deploy-trigger URL (secret `FORGE_DEPLOY_URL`).
2. `forge_deploy.sh`: `$CREATE_RELEASE()`, strip the token from the remote URL,
   `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm build`, **`pnpm db:migrate`**, delete `node_modules`
   and `.nuxt`, `$ACTIVATE_RELEASE()`, `sudo supervisorctl restart daemon-912439:daemon-912439_00`, then a
   non-fatal `pnpm store prune` (the pnpm store is shared by every site on the box).

`forge` may run `supervisorctl restart|start|stop|status|update` without a password (`util/infra/droplet.md`).

## nginx

`nginx.conf` sets `client_max_body_size 8m` (Zwift FIT uploads), serves `/_nuxt/` with `gzip_static` and
`expires 1y; immutable`, and includes `forge-conf/3264841/site.conf` for the proxy. Shared pieces come from
`~/Code/util/infra/nginx/` (`snippets/bot-mitigation.conf`, the `sprocket_api` zone — commented out).

## Scheduled jobs

Forge Scheduler (user `forge`), written out in `crontab`: **`segment reconcile`**, daily at 04:00, POSTs to
`/api/segments/reconcile` with `NUXT_SEGMENTS_SYNC_TOKEN`. A second job, `update-power-bests`, is disabled and kept
in Forge only as a fallback from the power-bests refactor; it isn't needed.

These jobs do not appear in `crontab -l` for `forge` or `root` on the droplet, so Forge runs them some other way.
They won't keep running by themselves once Forge is gone.

## Things to check

- The Mac-side Zwift daemons need the tokens in their plists to equal `NUXT_ZWIFT_SYNC_TOKEN` /
  `NUXT_ZWIFT_ACTIVITY_TOKEN` in the server `.env`.

## Leaving Forge — what needs a new owner

- **The Forge macros** `$CREATE_RELEASE()` / `$ACTIVATE_RELEASE()`: clone, `current` swap, pruning, the `.env`
  link and the `storage/fit-files` linked directory.
- **Deploy trigger** — SSH as `forge` replaces the curl in `ci.yml`.
- **vhost includes** — inline `forge-conf/3264841/site.conf` and the redirects, drop the `# FORGE …` lines.
- **The daemon** — `supervisord.conf` is an ordinary supervisor program and stays as is.
- **TLS** — Forge-managed `ssl_certificate` paths (`/etc/nginx/ssl/domains/1764571/<cert-id>/`), rewritten on every
  renewal; keep `/.well-known/acme-challenge/` served from `/home/forge/.letsencrypt/`.
- **The scheduled job** — add the `segment reconcile` line from `crontab` to the `forge` crontab.
