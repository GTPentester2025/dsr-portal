# `dsr_deploy.py`: the RHEL 9 deployer

Operator runbook for `deploy/dsr_deploy.py`. One command, run on the RHEL 9
server itself, that provisions the host, deploys the portal to it, verifies
it, and diagnoses it when something is wrong. It does not touch the existing
Ubuntu droplet.

```bash
sudo python3 deploy/dsr_deploy.py
```

That is the whole invocation. There is no SSH in it: this tool runs *on* the
box, from the repository you cloned there.

## The Ubuntu scripts are untouched

`deploy/deploy.sh`, `deploy/provision.sh`, `deploy/nginx.conf`,
`deploy/setup-db.sh`, `deploy/backup.sh`, `deploy/enable-tls*.sh`,
`deploy/install-backups.sh` and `deploy/dsr-api.service` are the bash
tooling that has run the existing droplet since before this tool existed.
Nothing here changed them, and `dsr_deploy.py` does not call them. If you
are deploying to the droplet you already have, keep using those scripts
exactly as before. `dsr_deploy.py` is for a *second*, RHEL 9, host.

(`dsr_deploy.py` does read `deploy/nginx.conf` and `deploy/dsr-api.service`
as templates it installs on the RHEL box, and it re-implements the same
roles/database SQL `setup-db.sh` runs — but it never invokes those scripts,
and editing them has no effect on it.)

## Getting started

On the RHEL 9 box, as root:

```bash
git clone <this repo> /root/dsr-portal
cd /root/dsr-portal
sudo python3 deploy/dsr_deploy.py
```

The first run stops almost immediately and tells you to fill in four values.
That is expected — see below. Fill them in, run the same command again, and
it goes all the way through.

### Prerequisites

- A RHEL 9 host (or a compatible rebuild — Alma, Rocky, CentOS Stream 9).
  RHEL 9 ships `/usr/bin/python3` at 3.9, which is what this targets; there
  is nothing to `pip install`.
- Root. It installs packages, writes under `/etc` and `/opt`, and manages
  systemd units.
- Outbound network access for `dnf` and `npm`.

You do **not** need: an SSH key, a `.target.env`, a second machine, or any
password of your own invention.

### The one thing you have to supply

The portal sends mail through Microsoft Graph, with credentials from an
Entra app registration that this tool cannot invent. On the first run it
writes `deploy/.secrets.env` as a commented template, prints its path, and
exits non-zero:

```
PRIVACY_MAILBOX=
GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=
```

Fill those in (`sudo nano deploy/.secrets.env`) and run the command again.
The file is created mode `600`, is gitignored, and is **never overwritten**
once it exists — a redeploy reads it and leaves it alone. You are never
prompted for a secret at the terminal, deliberately: a client secret typed
or pasted at a prompt ends up in the scrollback and in root's shell history.

`SECRETS_FILE=/path/to/other.env` overrides the location.

### The secrets you never see

`DB_PASS`, `APP_PASS` and `CRYPTO_MASTER_KEY` are only ever used by the
portal talking to itself, so the deployer generates them:

- `DB_PASS` / `APP_PASS` — 32 random bytes as hex. Hex specifically: these
  are interpolated into `postgres://user:PASS@127.0.0.1:5432/dsr` with no
  percent-encoding, and `/ @ : ? # %` in a password there is read as URL
  structure by node-postgres, which fails authentication in a way nothing
  explains.
- `CRYPTO_MASTER_KEY` — 32 random bytes, base64.

**`CRYPTO_MASTER_KEY` is generated once and reused for ever.** Every secret
row in `app_settings` is encrypted with it and there is no second copy: a
redeploy that wrote a new one would make every one of those rows permanently
unreadable, silently. So each run reads `/opt/dsr/server/.env` first, keeps
every value already in it, and generates only what is genuinely missing. If
that file exists but cannot be read, the run refuses rather than treating it
as a first deployment.

Back up `/opt/dsr/server/.env`. It is the only copy of that key.

## What one run does

Ten numbered steps, so a failure says how far it got:

| Step | What it does |
|---|---|
| 1 | Preflight: root, RHEL 9, a complete checkout, a log to write to |
| 2 | Surveys the box: every other TCP listener, and the command to stop it |
| 3 | Secrets: reads the installed `.env`, keeps it, generates what is missing |
| 4 | Checks there is disk space for the packages |
| 5 | Provisions the host (the thirteen steps below) |
| 6 | Builds the three bundles (`npm run build`) |
| 7 | Checks there is disk space for the deployment |
| 8 | Installs the built bundles into `/opt/dsr` and `/var/www/dsr` |
| 9 | Deploys: `.env`, `npm ci`, migrations, form schemas, unit, nginx, restart |
| 10 | Health check, then every diagnostic check as a final verification |

Re-running is the normal way to finish a half-completed run: every step is
idempotent.

### The flags

```bash
sudo python3 deploy/dsr_deploy.py --diagnose     # checks only; changes nothing
sudo python3 deploy/dsr_deploy.py --dry-run      # print the plan; touch nothing
sudo python3 deploy/dsr_deploy.py --skip-build   # reuse the existing dist/
sudo python3 deploy/dsr_deploy.py --diagnose --disk    # one group only
```

`--diagnose` takes a group filter: `host`, `disk`, `database`, `service`,
`web`, `selinux`. There is no flag that deletes, repairs or disables
anything on the box. A flag this tool does not have is a refusal, not a
silently-ignored argument — `--dryrun` will not run a real deployment.

### The log

Every run writes `/var/log/dsr-deploy/deploy-<YYYYmmdd-HHMMSS>.log`: each
step's command, exit code, stdout and stderr — the detail the terminal
summarises. The last ten runs are kept and older ones are deleted, because
disk is the binding constraint on this box.

**Every line is filtered through the same redaction the terminal output
uses** before it is written, so a generated password or a connection string
cannot land in it. That is what makes the file safe to send to somebody when
you need help — which is what it is for.

### If a step fails

The deployer runs the diagnostic checks itself and prints the findings with
the failure, so you get "what is wrong" rather than only an exit code. The
same happens when the health poll times out. The failure message names the
log file to send on.

## This box may be running something else

The DSR nginx site claims `listen 80 default_server`, and nginx refuses to
start with two of those. So before installing its own site, step 9 **moves
every other `/etc/nginx/conf.d/*.conf` into
`/etc/nginx/conf.d.disabled-<YYYYmmdd-HHMMSS>/`**, prints each filename as
it moves, and prints the single command that puts them all back:

```
mv /etc/nginx/conf.d.disabled-20260831-120000/*.conf /etc/nginx/conf.d/ \
  && nginx -t && systemctl reload nginx
```

Files are **moved, never deleted**, into a timestamped directory so two runs
cannot overwrite each other's rescue copy. If `nginx -t` then rejects the
DSR site, the deployer puts the previous `conf.d/dsr.conf` back, brings the
displaced sites back, reloads nginx onto what it was serving a moment ago,
and fails the step — a failed DSR deployment does not leave another site
down.

**No service is ever stopped.** Step 2 prints every other TCP listener, the
systemd unit that owns it, and the exact command to turn it off:

```
  port 5567   python3 (pid 4242)
      systemctl stop data-formulator.service && systemctl disable data-formulator.service
```

Moving a config file back is one command; stopping a daemon on a box nobody
has inventoried can take down someone else's production with nothing on
screen to say what it was. So the decision stays with you. Port 22 is left
out of that list deliberately.

For the same reason, PostgreSQL is **not** upgraded in place. If the box
already has PostgreSQL and it is not 16, provisioning refuses and says so:
swapping the binaries under a data directory `initdb`'d by an older major
leaves the cluster unable to start, and anything else using it down with it.
That is `pg_upgrade`'s job and a decision for whoever owns the data.

## What provisioning changes on the box (step 5)

Audit this list before running it — every step is idempotent, so re-running
after reading it is safe:

1. Installs base packages: `nginx`, `policycoreutils-python-utils`,
   `firewalld`, `curl`, `ca-certificates`, `tar` (via `dnf`; cache cleaned
   after). `tar` is on that list because `deploy/backup.sh` archives
   `/opt/dsr/uploads` and the database dump with it on a timer, and RHEL 9
   minimal installs do not reliably ship it.
2. Installs Node.js 22 from the AppStream module
   (`dnf module enable nodejs:22`), then asserts `node -v` reports major
   ≥ 22 — after the install, `&&`-chained, so an install that produced
   something older fails the step rather than passing it.
3. Installs PostgreSQL 16 from AppStream
   (`dnf module enable postgresql:16`) and runs
   `postgresql-setup --initdb` if the data directory is empty, then starts
   and enables the `postgresql` service. It asks `postgres --version` both
   before and after: RHEL 9's default stream is PostgreSQL 13 and the
   package name is the same on every stream, so a host where someone had
   already run `dnf install postgresql-server` would otherwise skip this
   step and run 13 under a step named "install PostgreSQL 16".
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
   Takes a one-time backup at `nginx.conf.orig` and leaves a marker
   comment. `nginx -t` must pass before the service is enabled and started.
   `deploy/nginx.conf` is installed as `/etc/nginx/conf.d/dsr.conf` later,
   in step 9 of the run, after any other site has been moved aside — see
   "This box may be running something else" above.
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

## Reading the checks

`--diagnose` output — which is also what step 10 prints — is grouped (`[host]`, `[disk]`, `[database]`, `[service]`, `[web]`,
`[selinux]`), one line per finding: `ok`, `WARN`, or `FAIL`, a title, and
where relevant a detail line and a `fix:` line giving the exact command to
run. Nothing is auto-applied — the checks only ever print the fix.

Exit codes, so it is usable from cron or a monitoring check and not only by
a human reading it:

| Exit code | Meaning |
|---|---|
| `0` | clean — every finding is `ok` |
| `1` | warnings only — nothing is broken, something is worth a look |
| `2` | one or more failures |

A cron job can be as simple as `dsr_deploy.py --diagnose --no-state \|\|
mail -s "DSR checks failed" ops@example.com` and rely on that exit code
alone.

`--diagnose` writes exactly one thing to the box: its own measurement history
at `/var/lib/dsr-deploy/state.json`, which is what lets the `[disk]` group
report growth-per-day and days-until-full instead of a single snapshot.
`--no-state` skips even that.

## The disk story

The target host has roughly 10 GB of storage, most of it already spoken
for, so disk is treated as a first-class constraint rather than an
afterthought:

- **Measured before acting.** Provisioning and deployment each have an
  estimated cost, and steps 4 and 7 refuse with real
  numbers — `<mount> has <free> free; this step needs about <wanted>` —
  rather than dying halfway through a step.
- **Spent carefully.** zram instead of a swapfile, a capped journal, and
  `dnf`/`npm` caches cleaned after use.
- **Projected, not just reported.** With two or more runs on
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
except to create the directory once during provisioning. The checks
measure its size and its growth rate and stops there — it has no delete, no
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
on`, run once while provisioning. Everything else the `[selinux]` group
does is read-only: `getenforce`, the boolean's current state, the
web root's file context, and recent AVC denials via `ausearch`.

## Troubleshooting

| Symptom | What the checks show | Fix |
|---|---|---|
| **502 on every request; nginx error log says only `Permission denied while connecting to upstream`** | `[web] FAIL the API answers directly but not through nginx` — with detail naming the direct probe's status, the proxied probe's status, and `httpd_can_network_connect`. The `[selinux]` group shows the boolean off. | `setsebool -P httpd_can_network_connect on` |
| `nginx -t` fails after a provision or a manual edit | `[web]` reports the `nginx -t` output verbatim | fix the reported config line, then `systemctl reload nginx` |
| `pg_hba` still on `ident` (every DB query fails auth) | `[database]` reports the role(s) that cannot authenticate over loopback | `sudo python3 deploy/dsr_deploy.py` (idempotent; re-running repairs a half-finished pg_hba edit) |
| Service crash-looping | `[service]` reports `dsr-api`'s restart count and the last journal lines | read the journal lines the run prints; usually a bad `.env` value |
| `403` on the public form | `[web]` names the SELinux file context on the web root as the likely cause | `restorecon -Rv /var/www/dsr` |
| `404` on the public form | `[web]` — nginx is serving an empty web root | `sudo python3 deploy/dsr_deploy.py` |
| Disk filling up | `[disk]` gives days-until-full once it has two or more samples, and lists reclaimable caches | clear the caches the report names; if uploads or the database are the growth, that needs more disk, not deletion |

### Why the 502/SELinux case is first, and how the checks actually know

This is the single most common RHEL deployment failure, and its only
symptom — that one nginx log line — names nothing: not SELinux, not the
boolean, not even which side of the proxy is at fault.

The checks turn that guess into a conclusion by probing the same thing two
ways:

- **Directly**, at `127.0.0.1:3000` — the Node process, with nginx out of
  the way.
- **Through nginx**, at `http://127.0.0.1/public/` — the same endpoint,
  proxied.

If the direct probe answers and the proxied one comes back as a 502 (or
another upstream-failure code), the API is healthy and nginx cannot reach
it — which is exactly what `httpd_can_network_connect` being off looks
like from outside. The report says so explicitly and points at the
`[selinux]` group.

The proxied probe deliberately hits `/public/`, not `/`. `deploy/nginx.conf`
serves `location /` straight from disk (the public-form static bundle), so
a probe against `/` would answer `200` even with the API process stopped
or with the SELinux boolean off — nginx would serve the static `index.html`
and the fault would never show up in the probe. `/public/` is the API
route nginx proxies to Node, so it can only answer successfully if nginx
actually reaches the app.
