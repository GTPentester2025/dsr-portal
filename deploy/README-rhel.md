# `dsr_deploy.py`: the RHEL 9 deployer

Operator runbook for `deploy/dsr_deploy.py`. This tool provisions a bare
RHEL 9 host, deploys the built portal to it, and diagnoses a host that is
misbehaving. It does not touch the existing Ubuntu droplet.

## The Ubuntu scripts are untouched

`deploy/deploy.sh`, `deploy/provision.sh`, `deploy/nginx.conf`,
`deploy/setup-db.sh`, `deploy/backup.sh`, `deploy/enable-tls*.sh`,
`deploy/install-backups.sh` and `deploy/dsr-api.service` are the bash
tooling that has run the existing droplet since before this tool existed.
Nothing in this task changed them, and `dsr_deploy.py` does not call them.
If you are deploying to the droplet you already have, keep using those
scripts exactly as before. `dsr_deploy.py` is for a *second*, RHEL 9, host.

(`dsr_deploy.py` does read `deploy/nginx.conf` as a template it copies to
the RHEL box, and it re-implements the same roles/database SQL
`setup-db.sh` runs — see the spec's Architecture section — but it never
invokes those scripts, and editing them has no effect on it.)

## Prerequisites

- A RHEL 9 host (or a compatible rebuild — Alma, Rocky) reachable over SSH
  as `root`. Provisioning assumes a bare box; deploying assumes `provision`
  has already run once.
- `deploy/.target.env`, gitignored, copied from `deploy/target.example.env`:

  ```
  DEPLOY_HOST=root@your-rhel-host.example.com
  PORTAL_BASE=https://privacy.example.com
  ```

- A secrets file, `deploy/.secrets.<host>.env` (or `deploy/.secrets.env` as
  the default), holding the same keys the bash tooling already uses:
  `DB_PASS`, `APP_PASS`, `CRYPTO_MASTER_KEY`, `COOKIE_SECURE`,
  `EMAIL_PROVIDER`, `PRIVACY_MAILBOX`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
  `GRAPH_CLIENT_SECRET`. `provision` only needs `DB_PASS` and `APP_PASS`;
  `deploy` needs the full set. Point at a non-default file with
  `SECRETS_FILE=deploy/.secrets.<host>.env`.
- Python 3.9+ on your machine (this tool's local half) — nothing to
  install on the RHEL box itself; RHEL 9 ships `/usr/bin/python3` at 3.9.

None of `deploy/.target.env`, `deploy/.secrets*.env`, or their contents are
read by anyone editing this runbook; treat them the way you already do —
gitignored, never pasted into a ticket or a chat.

## The three commands

Run all of these from the repo root, on your own machine.

`provision` and `deploy` copy the tool to `/root/dsr_deploy.py` before they
start, and use that copy for the two jobs that genuinely need Python on the
box: rewriting `pg_hba.conf` and `nginx.conf`, and reading the remote
`CRYPTO_MASTER_KEY` fingerprint before the `.env` is overwritten. Everything
else — every step, every check — is an individual SSH command. `doctor` does
not copy anything and does not need to: it runs thirty-one read-only commands
over SSH and works out what they mean on your machine.

You do not need to SSH in by hand for any of the three. If you are already on
the box, `python3 /root/dsr_deploy.py doctor --remote` reads it locally.

```bash
# Bare RHEL 9 box -> ready to receive a deployment. Idempotent: re-running
# is the normal way to finish a half-completed provision.
python3 deploy/dsr_deploy.py provision

# See the plan first, touching nothing:
python3 deploy/dsr_deploy.py provision --dry-run

# Build locally, push, migrate, restart, verify health.
python3 deploy/dsr_deploy.py deploy
python3 deploy/dsr_deploy.py deploy --dry-run

# Read the box and explain what is wrong. Changes nothing but its own
# measurement history (see below).
python3 deploy/dsr_deploy.py doctor

# Narrow to one group: host, disk, database, service, web, selinux.
python3 deploy/dsr_deploy.py doctor --selinux
python3 deploy/dsr_deploy.py doctor --disk

# Don't even record a measurement sample (for a box you want to leave
# bit-identical):
python3 deploy/dsr_deploy.py doctor --no-state
```

`--help` on the top-level command or any subcommand lists the flags. There
is no fourth command and no flag that deletes, repairs, or disables
anything on the box.

## What `provision` changes on the box

Audit this list before running it — every step is idempotent, so re-running
after reading it is safe:

1. Installs base packages: `nginx`, `policycoreutils-python-utils`,
   `firewalld`, `curl`, `ca-certificates` (via `dnf`; cache cleaned after).
2. Installs Node.js 22, preferring the AppStream module
   (`dnf module enable nodejs:22`), and asserts `node -v` reports major
   ≥ 22.
3. Installs PostgreSQL 16 from AppStream
   (`dnf module enable postgresql:16`) and runs
   `postgresql-setup --initdb` if the data directory is empty, then starts
   and enables the `postgresql` service.
4. Rewrites `/var/lib/pgsql/data/pg_hba.conf` so loopback (`127.0.0.1`,
   `::1`, `localhost`, `samehost`) uses `scram-sha-256` instead of RHEL's
   default `ident`. Takes a one-time backup at `pg_hba.conf.orig` and
   leaves a marker comment so re-running is a no-op.
5. Creates the `dsr` and `dsr_app` Postgres roles and the `dsr` database
   (UTF8, `template0`), the same SQL `setup-db.sh` already runs, executed
   through `psql`.
6. Creates the `dsr` system user (`/sbin/nologin`, no login shell) and the
   directories `/opt/dsr/server`, `/var/www/dsr/{public-form,admin}`, and
   `/opt/dsr/uploads` at mode `0750` owned `dsr:dsr` — so nothing else on
   the box can read a requester's identity documents. The web root is
   owned `nginx:nginx`.
7. Turns on the SELinux boolean `httpd_can_network_connect`, so nginx may
   proxy to the Node process. **This is the only SELinux change the tool
   makes.** It never runs `setenforce 0` and never suggests it — see below.
8. Rewrites `/etc/nginx/nginx.conf` once to remove RHEL's stock default
   server block (which otherwise collides with this portal's own default
   server and nginx refuses to start with `duplicate default server`).
   Takes a one-time backup at `nginx.conf.orig`, leaves a marker comment,
   and copies `deploy/nginx.conf` to `/etc/nginx/conf.d/dsr.conf`.
   `nginx -t` must pass before the service is enabled and started.
9. Opens `ssh`, `http`, `https` in `firewalld` (permanent) and reloads it.
10. Caps the systemd journal at `SystemMaxUse=200M` (RHEL's default is up
    to 10% of the filesystem, which on a ~10 GB box is real space).
11. Installs `zram-generator` and configures `zram0` at
    `min(ram / 2, 2048)` MB — compressed-RAM swap instead of a swapfile,
    which costs zero disk.

Nothing in this list deletes an existing file other than the `.orig`
backups it creates once, and nothing in it touches `/opt/dsr/uploads`
beyond creating the empty directory and setting its ownership the first
time.

## Reading `doctor` output

Output is grouped (`[host]`, `[disk]`, `[database]`, `[service]`, `[web]`,
`[selinux]`), one line per finding: `ok`, `WARN`, or `FAIL`, a title, and
where relevant a detail line and a `fix:` line giving the exact command to
run. Nothing is auto-applied — `doctor` only ever prints the fix.

Exit codes, so it is usable from cron or a monitoring check and not only by
a human reading it:

| Exit code | Meaning |
|---|---|
| `0` | clean — every finding is `ok` |
| `1` | warnings only — nothing is broken, something is worth a look |
| `2` | one or more failures |

A cron job can be as simple as `dsr_deploy.py doctor --no-state \|\| mail -s
"DSR doctor failed" ops@example.com` and rely on that exit code alone.

`doctor` writes exactly one thing to the box: its own measurement history
at `/var/lib/dsr-deploy/state.json`, which is what lets the `[disk]` group
report growth-per-day and days-until-full instead of a single snapshot.
`--no-state` skips even that.

## The disk story

The target host has roughly 10 GB of storage, most of it already spoken
for, so disk is treated as a first-class constraint rather than an
afterthought:

- **Measured before acting.** Every mutating step in `provision` and
  `deploy` has an estimated cost, and a preflight check refuses with real
  numbers — `<mount> has <free> free; this step needs about <wanted>` —
  rather than dying halfway through a step.
- **Spent carefully.** zram instead of a swapfile, a capped journal, and
  `dnf`/`npm` caches cleaned after use.
- **Projected, not just reported.** With two or more `doctor` runs on
  record, the `[disk]` group reports days-until-full for the filesystem
  holding uploads and the one holding the database. On the first run it
  says honestly that it has no baseline yet.
- **The reclaimable-space report is deliberately incomplete.** It lists the
  `dnf` cache, the `npm` cache, and the journal — all safe to clear because
  something else will regenerate them. It never lists uploads, and it
  never lists the database.

**Uploads are never deleted by this tool, and no command in it can.**
Identity documents submitted with a data-subject request are regulatory
records; `/opt/dsr/uploads` is not writable by anything this tool runs
except to create the directory once during provisioning. `doctor` measures
its size and its growth rate and stops there — it has no delete, no
archive, no offload command, by design, not by omission. If the projection
says the uploads mount is going to fill, the fix is more disk, not fewer
uploads.

## SELinux: what this tool does and does not do

**This tool never disables SELinux and never suggests it, anywhere in its
output.** Turning SELinux off (`setenforce 0` / `SELINUX=disabled`) is the
fix people reach for when RHEL returns a mysterious 502, and it is the
wrong fix on a box holding identity documents — it doesn't just relax the
one rule that's blocking you, it removes the barrier around everything
else too. Confirm this for yourself at any time:

```bash
grep -rn "setenforce 0\|SELINUX=disabled" deploy/dsr_deploy.py   # no matches
```

The tool's one SELinux mutation is `setsebool -P httpd_can_network_connect
on`, run once during `provision`. Everything else the `[selinux]` doctor
group does is read-only: `getenforce`, the boolean's current state, the
web root's file context, and recent AVC denials via `ausearch`.

## Troubleshooting

| Symptom | What `doctor` shows | Fix |
|---|---|---|
| **502 on every request; nginx error log says only `Permission denied while connecting to upstream`** | `[web] FAIL the API answers directly but not through nginx` — with detail naming the direct probe's status, the proxied probe's status, and `httpd_can_network_connect`. The `[selinux]` group shows the boolean off. | `setsebool -P httpd_can_network_connect on` |
| `nginx -t` fails after a provision or a manual edit | `[web]` reports the `nginx -t` output verbatim | fix the reported config line, then `systemctl reload nginx` |
| `pg_hba` still on `ident` (every DB query fails auth) | `[database]` reports the role(s) that cannot authenticate over loopback | `python3 deploy/dsr_deploy.py provision` (idempotent; re-running repairs a half-finished pg_hba edit) |
| Service crash-looping | `[service]` reports `dsr-api`'s restart count and the last journal lines | read the journal lines `doctor` prints; usually a bad `.env` value |
| `403` on the public form | `[web]` names the SELinux file context on the web root as the likely cause | `restorecon -Rv /var/www/dsr` |
| `404` on the public form | `[web]` — nginx is serving an empty web root | `python3 deploy/dsr_deploy.py deploy` |
| Disk filling up | `[disk]` gives days-until-full once it has two or more samples, and lists reclaimable caches | clear the caches `doctor` names; if uploads or the database are the growth, that needs more disk, not deletion |

### Why the 502/SELinux case is first, and how `doctor` actually knows

This is the single most common RHEL deployment failure, and its only
symptom — that one nginx log line — names nothing: not SELinux, not the
boolean, not even which side of the proxy is at fault.

`doctor` turns that guess into a conclusion by probing the same thing two
ways from the box itself:

- **Directly**, at `127.0.0.1:3000` — the Node process, with nginx out of
  the way.
- **Through nginx**, at `http://127.0.0.1/public/` — the same endpoint,
  proxied.

If the direct probe answers and the proxied one comes back as a 502 (or
another upstream-failure code), the API is healthy and nginx cannot reach
it — which is exactly what `httpd_can_network_connect` being off looks
like from outside. `doctor` says so explicitly and points at the
`[selinux]` group.

The proxied probe deliberately hits `/public/`, not `/`. `deploy/nginx.conf`
serves `location /` straight from disk (the public-form static bundle), so
a probe against `/` would answer `200` even with the API process stopped
or with the SELinux boolean off — nginx would serve the static `index.html`
and the fault would never show up in the probe. `/public/` is the API
route nginx proxies to Node, so it can only answer successfully if nginx
actually reaches the app.
