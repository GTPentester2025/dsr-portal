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

`deploy/dsr_deploy.py`, invoked as `python3 deploy/dsr_deploy.py <command>`.
Python **3.9 or newer**, which is what RHEL 9 ships as `/usr/bin/python3`, so
there is nothing to install on either end. "One file" means the tool: its unit
tests live in a sibling file, because a test file is not something an operator
ever copies to a server.

An earlier draft of this section described a different architecture and
rejected the one that was built. It is corrected here rather than quietly
deleted, because the rejection was the argument the section used to justify
itself, and a spec that argues for something the code does not do is worse
than a spec that says nothing.

**What was drafted.** The local side would build, push one payload, and
invoke `ssh host "python3 /root/dsr_deploy.py --remote deploy"`; the remote
side would act and print one JSON document; the local side would render it.
The alternative — a Python script that runs `ssh host "…"` for each step, the
way `deploy.sh` does — was rejected because Windows OpenSSH has no
`ControlMaster`, so every step pays a full TCP and authentication round trip.

**What was built is that alternative.** Steps and collectors are individual
SSH commands. Measured against the real command bodies:

| command | SSH connections |
|---|---|
| `provision` | 17 |
| `deploy` | 27 on the healthy path, up to 47 when the health poll runs its full twenty probes |
| `doctor` | 33 |

No JSON document is produced anywhere: `doctor` collects thirty-one command
outputs over SSH and evaluates them **locally**, in the same pure functions
the unit tests call. That is what makes the evaluators testable without a
host, which is the property this tool is actually built around.

The connection cost is real and is the price paid for it. It is bearable
because `provision` and `deploy` are occasional and already dominated by
`dnf` and `npm`, and because `doctor` is thirty-three reads of a few
kilobytes each. If it ever stops being bearable, the fix is a batched
collector, not a rewrite.

**What the pushed copy is actually for.** `push_self` copies the tool to
`/root/dsr_deploy.py` as the first act of `provision` and `deploy` — not of
every command; `doctor` never pushes itself and never invokes `--remote`
remotely. `REMOTE_SELF` is used for exactly two jobs, both of which genuinely
need Python on the box:

- rewriting `pg_hba.conf` and `nginx.conf` (`_remote_text_fix`), where the
  alternative is a `sed` expression inside three levels of quoting — the
  failure `deploy.sh` documents in a comment: *"inline escaping of `$1`
  inside a double-quoted ssh command is how this broke once already"*; and
- computing the remote `CRYPTO_MASTER_KEY` fingerprint before the `.env` is
  overwritten (`REMOTE_FINGERPRINT_COMMAND`).

`/root` rather than `/opt/dsr/` because `provision` runs against a bare host
where `/opt/dsr` and the `dsr` user do not yet exist; `/root` always does, and
`deploy/.target.env` already assumes a `root@host` SSH target.

`--remote` runs `doctor`'s collectors through a local runner instead of an
SSH one. The local half never invokes it — nothing pushes the tool for
`doctor` — so its only real user is an operator already logged in to the box,
which is what `target_ssh`'s "no ssh target" refusal points them at. It is
listed in `doctor --help` for that reason.

### Staging secrets

`provision` and `deploy` are the only two commands that ever handle a
credential, and both need the same thing: passwords and keys available to a
handful of remote steps without those values ever appearing in a `Step`
string, an argv element, a process list, or a log line. The mechanism is a
staging file: secrets are written to `/root/.dsr-secrets.env` at mode
`0600`, pushed to the box over the SSH transport's stdin rather than as a
command-line argument, `source`d by exactly the two or three steps that
need a value (role creation, writing `.env`), and removed in a
`try`/`finally` around the whole run — so a step that fails partway through
still leaves nothing on disk afterwards.

This is why no `Step` string anywhere in this design contains a credential:
every value a step needs is a shell variable reference like `${DB_PASS}`,
expanded on the box from the sourced file at the moment the step runs, never
substituted into the command text on the local side. It is also why
`--dry-run` is safe to run in front of anyone — the plan it prints is the
literal `Step` text, and that text was never allowed to hold a secret in the
first place.

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

`doctor --disk` restricts output to the disk group alone, not the host group
too — a flag named `--disk` that also printed host findings would surprise.
Each of the five other groups has its own equivalent flag. A global
`--dry-run` prints the plan for `provision` and `deploy` without executing it.

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
       See: dsr_deploy.py doctor --disk
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
3. **Node 22, AppStream only** — `dnf module enable nodejs:22 && dnf install
   -y nodejs`, `&&`-chained so an unavailable stream fails loudly at the step
   that needed it. A NodeSource RPM fallback was described in an earlier draft
   and deliberately not built, on the same ruling already recorded for
   PostgreSQL below: with no RHEL box available this session to exercise it, an
   untested fallback is a guess dressed up as a guarantee, and a guess that
   fires only on the host where the primary path already failed is the worst
   place to put one. If a host without the stream is ever hit in practice, add
   it then, against that host. Assert `node -v` reports major ≥ 22 after the
   install rather than trusting it.
4. **PostgreSQL 16, AppStream only** — service `postgresql`, data directory
   `/var/lib/pgsql/data`. A PGDG fallback (`postgresql-16` service,
   `/var/lib/pgsql/16/data`) was considered and deliberately not built: this
   tool always installs PostgreSQL itself from AppStream, so a PGDG layout
   only arises on a host where someone pre-installed Postgres differently
   before running this tool — and with no RHEL box available this session to
   exercise that path, an untested fallback would be a guess dressed up as a
   guarantee. If that situation is ever hit in practice, add the fallback then,
   against a real host. Then `postgresql-setup --initdb`, which Debian never
   required and without which the service exits immediately.
5. **`pg_hba.conf`.** Ensure `127.0.0.1/32` and `::1/128` use `scram-sha-256`.
   RHEL's default is `ident`, under which the API authenticates against nothing
   and every query fails. Edited by parsing the file and rewriting the matching
   lines, with a `.orig` backup and a managed marker so a second run is a no-op.
   Both this rewrite and nginx's below go through one atomic-write routine
   rather than an in-place edit: the new content is written to a temp file
   in the same directory, its mode and ownership are copied from the
   original, and `os.replace` swaps it into place in one step. A process that
   dies mid-write — a dropped SSH connection, an OOM kill on a 1-vCPU box —
   leaves the original file wholly intact instead of truncated, which for
   `pg_hba.conf` is the difference between a config edit and a host that can
   no longer authenticate any database connection. The `.orig` backup itself
   is taken once, guarded the same way the marker guards the rewrite, so a
   second run does not overwrite a real backup with an already-edited file.
6. **Roles and database.** The same SQL `setup-db.sh` runs today, executed
   through `psql`: owner `dsr`, restricted `dsr_app` that RLS depends on,
   database owned by `dsr`, UTF8, `template0`.
7. **Service user and directories.** `dsr` with `/sbin/nologin` — not Debian's
   `/usr/sbin/nologin`. `/opt/dsr/server`, `/var/www/dsr/{public-form,admin}`,
   and `/opt/dsr/uploads` at `0750` owned `dsr:dsr` so nothing else on the box
   can read a requester's identity documents.
8. **SELinux, left enforcing.** `setsebool -P httpd_can_network_connect on` so
   nginx may proxy to the API, and `restorecon -R` over the web root and the
   install prefix. An earlier draft also called for `semanage fcontext -a -t
   httpd_sys_content_t "/var/www/dsr(/.*)?"`. No such call exists and none is
   needed: RHEL's base policy already maps `/var/www(/.*)?` to
   `httpd_sys_content_t`, so `restorecon -R` on its own gives `/var/www/dsr`
   the right label. A local `fcontext` rule there would add a permanent entry
   to the box's policy store that restates what the base policy already says.
   What the rule was really guarding against — a directory `mv`d into place
   carrying `admin_home_t` in from `/root` — is caught instead: `restorecon`
   fixes it, and `doctor` reads `ls -Zd` on the web root and reports the label
   it finds, so a wrong one is visible rather than assumed.
   **The tool never runs `setenforce 0` and never suggests it.** Disabling SELinux is the fix people
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
structured to make it so. The design decision that makes `doctor` testable
without a server at all is the split between collectors and evaluators. A
collector runs exactly one command against the box — `psql`, `getsebool`,
`df`, `journalctl` — and returns whatever text came back, uninterpreted; it
does no comparisons and reaches no conclusions. An evaluator is a pure
function from that text to a list of `Finding`s: given the string a
collector could have produced, it decides severity and writes the fix,
touching no subprocess, no file, no network. Only evaluators are unit-tested
— a test hands an evaluator a captured or hand-written string exactly like
`psql -tAc '…'` would produce, and asserts on the `Finding`s it returns.
Collectors are exercised only by running `doctor` against a real host, the
same as provisioning. This split is what lets every failure mode `doctor`
recognizes — a `pg_hba` still on `ident`, a crash-looping service, the
`httpd_can_network_connect` boolean off — be encoded as a test against a
string literal instead of a fixture host, and it is the most reusable idea
in this sub-project: any future diagnostic follows the same shape.

These are the parts that carry real bugs and all of them are testable
offline:

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
- the Python 3.9 target itself: a test parses the module with
  `ast.parse(source, feature_version=(3, 9))`, which makes the parser reject
  3.10+ grammar, plus an AST walk that rejects `tomllib`, `datetime.UTC`,
  `hashlib.file_digest`, `itertools.pairwise` and `ExceptionGroup` by name —
  none of which are grammar changes the parser would catch on its own. This
  one matters more than it looks: a single 3.10-only construct would make
  `import dsr_deploy` fail immediately on every real RHEL 9 box, while every
  test in this suite kept passing on whatever newer Python runs them locally.

Provisioning a host cannot be unit tested. That part is verified on a real box,
and the spec says so rather than pretending otherwise.

## Verification

```bash
python3 -m unittest discover -s deploy          # the pure parts
python3 deploy/dsr_deploy.py --help
python3 deploy/dsr_deploy.py provision --dry-run   # prints the plan, touches nothing
python3 deploy/dsr_deploy.py doctor                # read-only, safe against a live box

# on a real RHEL 9 host, in order:
python3 deploy/dsr_deploy.py provision
python3 deploy/dsr_deploy.py deploy
python3 deploy/dsr_deploy.py doctor                # expect: exit 0
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
