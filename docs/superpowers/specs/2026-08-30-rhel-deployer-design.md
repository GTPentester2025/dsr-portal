# RHEL deployer: one file that provisions, deploys, and explains itself

Status: approved for planning
Date: 2026-08-30
Sub-project 4 of 5 (email → RBAC hardening → SSO seams → scale hardening → **RHEL deployer**)

## Context

The portal has a working deployment, and it is for the wrong operating system.
`deploy/provision.sh` is Debian: `apt-get`, `DEBIAN_FRONTEND`, `ufw`, the
NodeSource `.deb` repository. `deploy/deploy.sh` chowns `www-data`, symlinks
`/etc/nginx/sites-available/dsr` into `sites-enabled`, and deletes a
`sites-enabled/default` file. None of those exist on Red Hat.

The differences are not cosmetic, and each one fails in a way that does not name
its own cause:

| Ubuntu assumption | RHEL reality | How it fails |
|---|---|---|
| `apt-get`, `ufw` | `dnf`, `firewalld` | command not found |
| NodeSource `.deb` | AppStream module or NodeSource `.rpm` | no Node at all |
| Postgres cluster auto-created | needs `postgresql-setup --initdb` | `postgresql` starts, then exits; empty data directory |
| `pg_hba.conf` allows password auth on loopback | defaults to `ident` for host connections | API boots, then every query fails authentication |
| `www-data` | `nginx` | web root unreadable, 403 on every page |
| `sites-available` + `sites-enabled/default` | `/etc/nginx/conf.d/*.conf`, default server block **inside `nginx.conf`** | `duplicate default server` — nginx refuses to start |
| SELinux absent | SELinux enforcing | nginx cannot connect to 127.0.0.1:3000; 502 on every request, nothing in the nginx error log that explains it |

That last one is the reason this tool needs a diagnosis mode at all. A 502 with
an nginx log that says only `Permission denied while connecting to upstream` is
the single most common RHEL deployment failure, and the fix — one boolean —
is unguessable from the symptom.

`deploy/smoke.mjs` already tests the deployed portal from outside over HTTPS. It
is a good black-box test and it answers a different question: it reports *that*
the portal is broken, never *why*. Nothing today reads the state that explains a
failure — SELinux booleans, `pg_hba.conf`, systemd restart counters, cert
expiry, free disk.

### The host is small

The target box has roughly 10 GB of storage, most of it already used, across
`/home`, `/var` and `/opt`. This is not a footnote; it changes decisions.

A straight port of `provision.sh` would `fallocate -l 2G /swapfile` and consume
a fifth of the filesystem before installing anything. The things that grow
without being watched — `node_modules`, the Postgres cluster, `journald` (which
defaults to using up to 10% of its filesystem), the `dnf` cache, and above all
uploaded identity documents — will fill this box, and the portal's failure mode
when the database's filesystem is full is not a clean error.

So disk is a first-class concern throughout: measured before acting, budgeted
per step, and reported by `doctor` with a projection rather than a snapshot.

## Scope

In scope: one Python file, standard library only, run from the operator's
machine, that provisions a bare RHEL 9 host, deploys the built portal to it, and
diagnoses a host that is misbehaving.

Out of scope, each for a stated reason:

- **Ubuntu.** The existing bash scripts keep working for the existing droplet and
  are not touched. One tool that branches per distribution means every step has
  two code paths and only one of them is ever exercised.
- **RHEL 8.** Its system Python is 3.6. Supporting it constrains every line of
  this file for a release whose successor is already current.
- **Attachment retention or offloading.** `doctor` warns; it never deletes. These
  are regulatory records.
- **High availability, multi-node, blue/green, containers, CI integration.** One
  box, one process, one command.

## Architecture

### One file, two sides

`deploy/dsr-deploy.py`, invoked as `python3 deploy/dsr-deploy.py <command>`.
Python **3.9 or newer**, which is what RHEL 9 ships as `/usr/bin/python3`, so
there is nothing to install on either end. "One file" means the tool: its unit
tests live in a sibling file, because a test file is not something an operator
ever copies to a server.

The alternative — a Python script that runs `ssh host "…"` for each step, the
way `deploy.sh` does — was rejected for two reasons. Windows OpenSSH has no
`ControlMaster`, so each of roughly twenty-five steps pays a full TCP and
authentication round trip. And every remote step becomes Python quoting bash
quoting shell, which is the failure `deploy.sh` already documents in a comment:
*"inline escaping of `$1` inside a double-quoted ssh command is how this broke
once already."*

Instead the local side does three things — build, push one payload, invoke the
remote side — and the remote side runs as a normal Python process on the box:

```
local:   dsr-deploy.py deploy
           → validate secrets, budget disk, build, tar → ssh
           → ssh host "python3 /root/dsr-deploy.py --remote deploy"
remote:  reads real state, acts, prints one JSON document
local:   renders that document as human output, sets the exit code
```

The tool copies **itself** to `/root/dsr-deploy.py` as the first act of every
command. That path rather than `/opt/dsr/` because `provision` runs against a
bare host where `/opt/dsr` and the `dsr` user do not yet exist; `/root` always
does, and the existing `deploy/.target.env` already assumes a `root@host` SSH
target.

`--remote` is internal. An operator never types it.

Everything that needs to *read* machine state does so in Python, where
`pg_hba.conf` is a file to parse rather than a `sed` expression inside three
levels of quoting.

### Talking to Postgres without a driver

Standard library Python has no Postgres client, and `pip install` is exactly
what "standard library only" rules out. Every database operation therefore goes
through one of two things already present on the box:

- `psql -tAc '…'` for reads that `doctor` needs — role existence, `pg_hba` rules
  in effect, applied migrations, table sizes.
- The node scripts the repo already has and already tests: `scripts/migrate.mjs`,
  `scripts/import-forms.mjs`, `scripts/rls-check.mjs`, `scripts/explain-check.mjs`.

This is a constraint that turned out to be a feature. The deployer does not
reimplement migration logic that exists, is tested, and would silently drift.

### Commands

| Command | Does | Mutates |
|---|---|---|
| `provision` | bare RHEL 9 → host ready to receive a deployment | yes |
| `deploy` | build locally, push, migrate, restart, verify health | yes |
| `doctor` | read the box and explain what is wrong | its own state file only |

`doctor` never repairs, because a tool that both diagnoses and silently fixes is
a tool whose output you cannot trust as a description of the machine. It prints
the fix as a command to run.

The one thing it writes is its own measurement history at
`/var/lib/dsr-deploy/state.json`, which is what makes the growth projection
below possible. It touches nothing belonging to the portal — no service, no
config, no database, no uploaded file — and `--no-state` suppresses even that,
for running against a box you want to leave bit-identical.

`doctor --disk` restricts output to the host and disk group; the other groups
have equivalent flags. A global `--dry-run` prints the plan for `provision` and
`deploy` without executing it.

### Disk as a first-class constraint

**Measured, not assumed.** The tool reads the mount table and `statvfs` for each
path it will write to — the install prefix, the web root, the Postgres data
directory, `/var/log/journal`, `/var/cache/dnf`, `/tmp`. Whether `/home`, `/var`
and `/opt` are separate mounts or one root filesystem is detected rather than
configured, because the answer changes whether moving a directory buys anything.

**Budgeted before acting.** Each mutating step declares an estimated cost, and
preflight refuses with real numbers rather than failing halfway:

```
FATAL: /opt has 240 MB free; deploy needs ~420 MB
       (node_modules ~310 MB, dist ~40 MB, transfer headroom ~70 MB)
       Reclaimable now: 180 MB dnf cache, 96 MB journal, 55 MB npm cache.
       See: dsr-deploy.py doctor --disk
```

A refusal that names the number and where to find the space is the difference
between a five-minute fix and an afternoon.

**Spent carefully.** zram instead of a swapfile — `zram-generator` with
`zram-size = min(ram / 2, 2048)` costs no disk at all and gives a 1-vCPU box the
headroom it needs during `npm ci`. `journald` capped with an explicit
`SystemMaxUse` rather than its 10%-of-filesystem default. `dnf clean all` after
package installation and `npm cache clean --force` after `npm ci`, both of which
otherwise leave hundreds of megabytes of nothing useful.

**Projected, not just reported.** `doctor` keeps a small state file at
`/var/lib/dsr-deploy/state.json` recording each run's measurements. With two or
more samples it reports growth per day and days-until-full for the uploads
directory and the database. On a first run it says it has no baseline yet, which
is honest and costs nothing.

Uploads are never deleted, and the tool has no command that could. It reports
size, growth and projection, and it warns early.

### What provisioning actually does

Idempotent throughout — every step is safe to re-run, and re-running is the
normal way to repair a half-finished provision.

1. **Preflight.** RHEL 9 or a compatible rebuild; free disk per mount; RAM;
   `dnf` reachable.
2. **Packages.** `nginx`, `policycoreutils-python-utils` (for `semanage`),
   `firewalld`, `tar`, `zram-generator`. EPEL only if certbot is wanted.
3. **Node 22.** Prefer the AppStream module (`dnf module enable nodejs:22`);
   fall back to the NodeSource RPM when that stream is unavailable. Either way,
   assert `node -v` reports major ≥ 22 rather than trusting the install.
4. **PostgreSQL 16.** Prefer the AppStream module — service `postgresql`, data
   directory `/var/lib/pgsql/data`. Fall back to PGDG, where the service is
   `postgresql-16` and the data directory `/var/lib/pgsql/16/data`. Which one is
   in use is recorded in the state file, because every later step needs the right
   name. Then `postgresql-setup --initdb`, which Debian never required and
   without which the service exits immediately.
5. **`pg_hba.conf`.** Ensure `127.0.0.1/32` and `::1/128` use `scram-sha-256`.
   RHEL's default is `ident`, under which the API authenticates against nothing
   and every query fails. Edited by parsing the file and rewriting the matching
   lines, with a `.orig` backup and a managed marker so a second run is a no-op.
6. **Roles and database.** The same SQL `setup-db.sh` runs today, executed
   through `psql`: owner `dsr`, restricted `dsr_app` that RLS depends on,
   database owned by `dsr`, UTF8, `template0`.
7. **Service user and directories.** `dsr` with `/sbin/nologin` — not Debian's
   `/usr/sbin/nologin`. `/opt/dsr/server`, `/var/www/dsr/{public-form,admin}`,
   and `/opt/dsr/uploads` at `0750` owned `dsr:dsr` so nothing else on the box
   can read a requester's identity documents.
8. **SELinux, left enforcing.** `setsebool -P httpd_can_network_connect on` so
   nginx may proxy to the API. `semanage fcontext -a -t httpd_sys_content_t
   "/var/www/dsr(/.*)?"` followed by `restorecon -R`. **The tool never runs
   `setenforce 0` and never suggests it.** Disabling SELinux is the fix people
   reach for, it is wrong, and a deployer that offers it teaches the wrong
   lesson on a box holding identity documents.
9. **nginx.** The repo's `nginx.conf` is a server block; it goes to
   `/etc/nginx/conf.d/dsr.conf`. RHEL's stock default server lives inside
   `/etc/nginx/nginx.conf` itself, so it must be neutralised or nginx fails with
   `duplicate default server`. The tool rewrites `nginx.conf` once, keeps
   `nginx.conf.orig`, and leaves a marker comment so it recognises its own prior
   edit. `nginx -t` must pass before the service is reloaded.
10. **firewalld.** `ssh`, `http`, `https` permanent, then reload.
11. **journald.** `SystemMaxUse` set explicitly.

### What deployment does

The local half validates before a single byte reaches the server, porting three
guards from `deploy.sh` that exist because each one has already gone wrong:

- `CRYPTO_MASTER_KEY` must base64-decode to exactly **32 bytes**. A hex string
  looks like a key, ships fine, and crash-loops the service at boot.
- The remote `.env`'s master key fingerprint must match the local one, so the
  wrong secrets file cannot be deployed to the wrong box. Comparison is over
  `hashlib` digests; **the tool never prints or logs a key**.
- `EMAIL_PROVIDER` must be `graph` or `console`, and under `graph` the four
  Graph credentials must be non-empty. Boot validation rejects anything else,
  which means a crash loop behind an nginx that is still serving the public
  intake form.

Then: build the three bundles locally, push one payload, write `.env` with a
`.env.bak` rollback copy, `npm ci --omit=dev`, run migrations and form import,
set ownership and SELinux contexts, install the unit and nginx config, restart,
and poll for health. The health check polls — twenty attempts, three seconds
apart — because on a 1-vCPU box Nest can take well over four seconds to bind and
a one-shot probe reports a false failure on a deployment that worked.

TLS handling is preserved from `deploy.sh`: if a certificate exists, re-apply it
after rewriting the nginx config, and restore `PUBLIC_BASE_URL` and
`INTERNAL_BASE_URL` if they were wiped — a missing public base URL means every
verification link mailed to a data subject is dead.

### What doctor checks

Grouped, each finding carrying a severity, what is wrong, and the command that
fixes it.

**Host** — distribution and version; free space per mount with the projection
described above; RAM and zram; the largest directories under the install prefix;
reclaimable space with the commands to reclaim it.

**Database** — service active; accepting connections; both roles present and
able to authenticate over loopback (the `pg_hba` failure, caught directly);
migrations applied versus migration files present; database and largest table
sizes.

**Service** — `dsr-api` active; **restart count**, which is how a crash loop is
distinguished from a healthy service; the last errors from the journal; port
3000 bound by the expected process; `/opt/dsr/server/.env` present, mode `0600`,
required keys non-empty, `CRYPTO_MASTER_KEY` decoding to 32 bytes.

**Web and TLS** — `nginx -t`; the duplicate-default-server condition
specifically; the API reachable through nginx from the box itself; certificate
presence and **days until expiry**.

**SELinux** — enforcing or not; `httpd_can_network_connect`; the file context on
the web root; and recent AVC denials via `ausearch`, correlated to the component
they affect. This is the group that turns an unexplained 502 into one line
naming the boolean.

Exit codes: `0` clean, `1` warnings only, `2` one or more failures — so `doctor`
is usable from a cron job or a monitoring check, not only by a human reading it.

## Testing

The repo's test suite is Jest over TypeScript and knows nothing about Python.
Adding pytest would mean a second toolchain for one file.

Instead: a sibling `deploy/test_dsr_deploy.py` using the standard library's
`unittest`, run with `python3 -m unittest discover -s deploy`. No network, no
server, no database.

That is only worth doing if the logic worth testing is pure, so the file is
structured to make it so. These are the parts that carry real bugs and all of
them are testable offline:

- secrets validation — the 32-byte rule against hex, base64 of the wrong length,
  whitespace, and empty; the Graph credential rule
- `df`/`statvfs` output parsing into per-mount free space, and the budget
  arithmetic that decides whether a step may proceed
- `pg_hba.conf` rewriting — that it changes `ident` to `scram-sha-256` for
  loopback only, leaves other rules alone, and is a no-op on a file it has
  already edited
- detection of RHEL's stock default server block in `nginx.conf`, and idempotent
  neutralisation
- Node and Postgres version comparison, including `22.1.0` against `22`
- growth-rate and days-until-full arithmetic, including the no-baseline case
- rendering a findings list to text and to the right exit code

Provisioning a host cannot be unit tested. That part is verified on a real box,
and the spec says so rather than pretending otherwise.

## Verification

```bash
python3 -m unittest discover -s deploy          # the pure parts
python3 deploy/dsr-deploy.py --help
python3 deploy/dsr-deploy.py provision --dry-run   # prints the plan, touches nothing
python3 deploy/dsr-deploy.py doctor                # read-only, safe against a live box

# on a real RHEL 9 host, in order:
python3 deploy/dsr-deploy.py provision
python3 deploy/dsr-deploy.py deploy
python3 deploy/dsr-deploy.py doctor                # expect: exit 0
node deploy/smoke.mjs                              # the existing black-box test, still passing
```

The proof that diagnosis works is adversarial and belongs in the verification
run: with the portal healthy, `setsebool -P httpd_can_network_connect off`,
confirm the portal 502s, and confirm `doctor` names that boolean and prints the
command. A diagnostic that has never been shown to catch a fault it was written
for is a diagnostic nobody should trust.

## What this deliberately leaves undone

**The existing bash scripts stay.** They work for the Ubuntu droplet. Deleting
them to make this the only deployer would strand a running system to tidy a
directory.

**No reclaim command.** `doctor` reports what is reclaimable and how, and stops.
Automatic deletion on a box holding regulatory records needs a stronger argument
than convenience, and the reporting is most of the value.

**No rollback beyond `.env.bak`.** Real rollback means keeping a previous release
on disk, and disk is the scarce resource here. Re-deploying a known-good commit
is the recovery path.

**No secrets management.** The tool reads the same `deploy/.secrets*.env` and
`deploy/.target.env` files the bash scripts use, so operators maintain one
format rather than two. Where those files come from is unchanged by this work.
