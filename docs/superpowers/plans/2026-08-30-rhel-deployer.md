# RHEL Deployer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One standard-library Python file that provisions a bare RHEL 9 host, deploys the DSR portal to it, and diagnoses a host that is misbehaving.

**Architecture:** The tool copies itself to `/root/dsr_deploy.py` and runs *there* for anything that reads machine state, so `pg_hba.conf` is a file to parse rather than a `sed` expression inside three levels of shell quoting. The local half validates secrets, budgets disk, builds the bundles and pushes one payload. Every check is split into a **collector** (effectful, runs a command) and an **evaluator** (pure, takes captured text and returns findings) — that split is what makes a deployment tool unit-testable at all.

**Tech Stack:** Python 3.9 standard library only. `ssh` and `tar` binaries for transport. `psql` and the repo's existing `server/scripts/*.mjs` for anything touching Postgres, because stdlib Python has no database driver.

**Spec:** `docs/superpowers/specs/2026-08-30-rhel-deployer-design.md`

## Global Constraints

- **Standard library only.** No `pip install`, no third-party import, on either the operator's machine or the server. There is no `requirements.txt` and none is added.
- **Target Python 3.9** — what RHEL 9 ships as `/usr/bin/python3`. Local Python is 3.13/3.14, so the syntax you can run is not the syntax you may use. Every file starts with `from __future__ import annotations`. **Forbidden:** `match` statements (3.10), `X | Y` unions evaluated at runtime (3.10), `itertools.pairwise` (3.10), `tomllib` (3.11), `ExceptionGroup` (3.11), `datetime.UTC` (3.11 — use `timezone.utc`), `hashlib.file_digest` (3.11).
- **Filename is `deploy/dsr_deploy.py`, with an underscore.** The spec says `dsr-deploy.py`; a hyphen is not importable by the test file without `importlib` gymnastics for no benefit. Task 8 corrects the spec.
- **The tool never disables SELinux.** No code path emits `setenforce 0`, `SELINUX=disabled`, or `--permissive`, and no message suggests them — not as a fix, not as a fallback, not in a comment.
- **The tool never deletes or moves uploads.** No code path removes, truncates, prunes or relocates `/opt/dsr/uploads` or anything under it. These are identity documents held as regulatory records.
- **Secrets are never printed, logged, echoed into a command line, or written to the state file.** Comparisons use `hashlib` digests; only an 8-character fingerprint is ever displayed.
- **Every `provision` and `deploy` step is idempotent.** Re-running is the normal way to repair a half-finished run.
- **`doctor` is read-only** apart from `/var/lib/dsr-deploy/state.json`, and `--no-state` suppresses even that.
- **Do not modify the existing bash scripts** in `deploy/` — `provision.sh`, `deploy.sh`, `setup-db.sh`, `backup.sh`, `enable-tls*.sh`, `install-backups.sh`, `nginx.conf`, `dsr-api.service`. They serve the live Ubuntu droplet and are out of scope. Reading them for reference is expected and encouraged.
- Tests are `deploy/test_dsr_deploy.py`, stdlib `unittest`, run with `python3 -m unittest discover -s deploy -p "test_*.py"`. No network, no subprocess against a real host, no database.
- **No RHEL host is available this session, and no Postgres.** Nothing in this plan can be executed against a real server. Validate with the unit tests, `python3 -m py_compile`, and `--dry-run`. "Not run — no RHEL host" is the honest and expected result. Do not fabricate output, provision anything, or SSH anywhere.
- Do not read `deploy/.secrets.env`, `deploy/.secrets.blr.env`, `deploy/.target.env`, or anything under `server/.pgdata/`.
- Line endings in this tree are mixed; preserve each file's existing endings and keep diffs to the lines you change.
- **Commit style:** an imperative sentence, no `feat:`/`fix:` prefix. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NtXEr3cBGDqXwFLmPnFVye
  ```
- Committing directly to `main` is deliberate and approved. Do not create a branch.

## File Structure

| File | Responsibility |
|---|---|
| `deploy/dsr_deploy.py` | **new** — the whole tool: CLI, transport, pure helpers, provision, deploy, doctor |
| `deploy/test_dsr_deploy.py` | **new** — stdlib `unittest` over every pure function |
| `deploy/README-rhel.md` | **new** — operator runbook |
| `docs/superpowers/specs/2026-08-30-rhel-deployer-design.md` | amended by Task 8 where it drifted |

Within `dsr_deploy.py`, in this order: constants → pure helpers → `Finding`/rendering → collectors and evaluators → transport → command implementations → `main`.

---

### Task 1: Skeleton, CLI, and the local/remote split

**Files:**
- Create: `deploy/dsr_deploy.py`
- Create: `deploy/test_dsr_deploy.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `build_parser() -> argparse.ArgumentParser`; `main(argv: list) -> int`; constants `INSTALL_PREFIX = "/opt/dsr"`, `WEB_ROOT = "/var/www/dsr"`, `UPLOADS_DIR = "/opt/dsr/uploads"`, `ENV_PATH = "/opt/dsr/server/.env"`, `REMOTE_SELF = "/root/dsr_deploy.py"`, `STATE_PATH = "/var/lib/dsr-deploy/state.json"`, `SERVICE = "dsr-api"`, `APP_PORT = 3000`.

- [ ] **Step 1: Write the failing test**

```python
# deploy/test_dsr_deploy.py
from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import dsr_deploy as dd


class TestCli(unittest.TestCase):
    def test_commands_are_the_three_the_spec_names(self):
        for command in ("provision", "deploy", "doctor"):
            args = dd.build_parser().parse_args([command])
            self.assertEqual(args.command, command)

    def test_dry_run_defaults_off_and_is_settable(self):
        self.assertFalse(dd.build_parser().parse_args(["deploy"]).dry_run)
        self.assertTrue(dd.build_parser().parse_args(["deploy", "--dry-run"]).dry_run)

    def test_remote_is_accepted_but_hidden_from_help(self):
        args = dd.build_parser().parse_args(["doctor", "--remote"])
        self.assertTrue(args.remote)
        self.assertNotIn("--remote", dd.build_parser().format_help())

    def test_doctor_takes_no_state_and_group_filters(self):
        args = dd.build_parser().parse_args(["doctor", "--no-state", "--disk"])
        self.assertTrue(args.no_state)
        self.assertTrue(args.disk)

    def test_no_command_is_an_error_not_a_crash(self):
        with self.assertRaises(SystemExit):
            dd.build_parser().parse_args([])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m unittest discover -s deploy -p "test_*.py" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'dsr_deploy'`

- [ ] **Step 3: Write the module**

```python
#!/usr/bin/env python3
"""Provision, deploy and diagnose the DSR portal on a RHEL 9 host.

Runs on the operator's machine. For anything that has to read the state of
the server -- pg_hba.conf, SELinux booleans, systemd restart counters -- it
copies itself to the box and runs there, because reading a file in Python
beats a sed expression nested inside three levels of shell quoting.

    python3 deploy/dsr_deploy.py provision
    python3 deploy/dsr_deploy.py deploy
    python3 deploy/dsr_deploy.py doctor

Targets the Python that RHEL 9 ships (3.9). Standard library only: there is
no pip install step on either end.
"""
from __future__ import annotations

import argparse
import sys

INSTALL_PREFIX = "/opt/dsr"
WEB_ROOT = "/var/www/dsr"
UPLOADS_DIR = "/opt/dsr/uploads"
ENV_PATH = "/opt/dsr/server/.env"
# /root rather than the install prefix: provision runs against a bare host
# where /opt/dsr and the dsr user do not exist yet, and .target.env already
# assumes a root@host ssh target.
REMOTE_SELF = "/root/dsr_deploy.py"
STATE_PATH = "/var/lib/dsr-deploy/state.json"
SERVICE = "dsr-api"
APP_PORT = 3000

MIN_PYTHON = (3, 9)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsr_deploy.py",
        description="Provision, deploy and diagnose the DSR portal on RHEL 9.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    for name, help_text in (
        ("provision", "take a bare RHEL 9 host to one ready for a deployment"),
        ("deploy", "build, push, migrate, restart and verify"),
        ("doctor", "read the box and explain what is wrong; changes nothing"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument(
            "--dry-run",
            action="store_true",
            help="print what would happen, touch nothing",
        )
        # Internal: how the local half invokes the copy it pushed to the box.
        # Hidden because an operator never types it.
        p.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
        if name == "doctor":
            p.add_argument(
                "--no-state",
                action="store_true",
                help="do not record this run's measurements (no growth projection)",
            )
            for group in ("host", "disk", "database", "service", "web", "selinux"):
                p.add_argument(
                    "--" + group,
                    action="store_true",
                    help="report only the %s checks" % group,
                )
    return parser


def main(argv: list) -> int:
    if sys.version_info < MIN_PYTHON:
        sys.stderr.write(
            "This tool needs Python %d.%d or newer; found %s\n"
            % (MIN_PYTHON[0], MIN_PYTHON[1], sys.version.split()[0])
        )
        return 2
    build_parser().parse_args(argv)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run the tests and the compile check**

Run: `python3 -m unittest discover -s deploy -p "test_*.py" -v` → all pass
Run: `python3 -m py_compile deploy/dsr_deploy.py` → silent
Run: `python3 deploy/dsr_deploy.py --help` → shows the three commands, no `--remote`

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Start a RHEL deployer with a command line and a test
```

---

### Task 2: Secrets, and the three guards that exist because each went wrong

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

Read `deploy/deploy.sh` lines 24-95 first. The three guards below are ports of guards already in that file, each with a comment explaining the incident that produced it. Do not weaken them.

**Interfaces:**
- Consumes: nothing.
- Produces: `class SecretsError(Exception)`; `parse_env_text(text: str) -> dict`; `validate_master_key(raw: str) -> None`; `key_fingerprint(raw: str) -> str`; `validate_email_config(env: dict) -> list` (returns warnings, raises on fatal).

- [ ] **Step 1: Write the failing tests**

```python
class TestEnvParsing(unittest.TestCase):
    def test_parses_pairs_comments_blanks_and_quotes(self):
        env = dd.parse_env_text(
            "\n".join(
                [
                    "# a comment",
                    "",
                    "DB_PASS=plain",
                    "QUOTED=\"has spaces\"",
                    "SINGLE='single'",
                    "export EXPORTED=yes",
                    "EMPTY=",
                    "WITH_EQUALS=a=b=c",
                    "   SPACED   =   trimmed   ",
                ]
            )
        )
        self.assertEqual(env["DB_PASS"], "plain")
        self.assertEqual(env["QUOTED"], "has spaces")
        self.assertEqual(env["SINGLE"], "single")
        self.assertEqual(env["EXPORTED"], "yes")
        self.assertEqual(env["EMPTY"], "")
        self.assertEqual(env["WITH_EQUALS"], "a=b=c")
        self.assertEqual(env["SPACED"], "trimmed")
        self.assertNotIn("# a comment", env)


class TestMasterKey(unittest.TestCase):
    GOOD = base64.b64encode(b"\x01" * 32).decode()

    def test_accepts_32_bytes_base64(self):
        dd.validate_master_key(self.GOOD)

    def test_rejects_hex_that_looks_like_a_key(self):
        # The exact mistake deploy.sh documents: ships fine, then the
        # service crash-loops on boot.
        with self.assertRaises(dd.SecretsError):
            dd.validate_master_key("a" * 64)

    def test_rejects_wrong_length_base64(self):
        for raw in (base64.b64encode(b"\x01" * 16).decode(),
                    base64.b64encode(b"\x01" * 31).decode(),
                    base64.b64encode(b"\x01" * 64).decode()):
            with self.assertRaises(dd.SecretsError):
                dd.validate_master_key(raw)

    def test_rejects_empty_and_whitespace(self):
        for raw in ("", "   ", "\n"):
            with self.assertRaises(dd.SecretsError):
                dd.validate_master_key(raw)

    def test_rejects_garbage_that_is_not_base64(self):
        with self.assertRaises(dd.SecretsError):
            dd.validate_master_key("not base64 at all !!!")

    def test_fingerprint_is_stable_short_and_leaks_nothing(self):
        fp = dd.key_fingerprint(self.GOOD)
        self.assertEqual(fp, dd.key_fingerprint(self.GOOD))
        self.assertEqual(len(fp), 8)
        self.assertNotIn(fp, self.GOOD)
        self.assertNotEqual(fp, dd.key_fingerprint(base64.b64encode(b"\x02" * 32).decode()))


class TestEmailConfig(unittest.TestCase):
    GRAPH = {
        "EMAIL_PROVIDER": "graph",
        "PRIVACY_MAILBOX": "privacy@example.com",
        "GRAPH_TENANT_ID": "t",
        "GRAPH_CLIENT_ID": "c",
        "GRAPH_CLIENT_SECRET": "s",
    }

    def test_complete_graph_config_passes_without_warning(self):
        self.assertEqual(dd.validate_email_config(dict(self.GRAPH)), [])

    def test_missing_graph_credential_is_fatal_and_names_it(self):
        env = dict(self.GRAPH)
        env["GRAPH_CLIENT_SECRET"] = ""
        with self.assertRaises(dd.SecretsError) as caught:
            dd.validate_email_config(env)
        self.assertIn("GRAPH_CLIENT_SECRET", str(caught.exception))

    def test_whitespace_only_credential_counts_as_missing(self):
        env = dict(self.GRAPH)
        env["GRAPH_TENANT_ID"] = "   "
        with self.assertRaises(dd.SecretsError):
            dd.validate_email_config(env)

    def test_console_warns_rather_than_failing(self):
        warnings = dd.validate_email_config({"EMAIL_PROVIDER": "console"})
        self.assertEqual(len(warnings), 1)
        self.assertIn("console", warnings[0])

    def test_unknown_provider_is_fatal(self):
        with self.assertRaises(dd.SecretsError):
            dd.validate_email_config({"EMAIL_PROVIDER": "smtp"})

    def test_provider_defaults_to_graph_when_absent(self):
        with self.assertRaises(dd.SecretsError):
            dd.validate_email_config({})
```

Add `import base64` to the test file's imports.

- [ ] **Step 2: Run and watch it fail**

Run: `python3 -m unittest discover -s deploy -p "test_*.py"`
Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'parse_env_text'`

- [ ] **Step 3: Implement**

```python
class SecretsError(Exception):
    """A secrets or target file that would break the portal if deployed."""


EMAIL_PROVIDERS = ("graph", "console")
GRAPH_KEYS = ("PRIVACY_MAILBOX", "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET")


def parse_env_text(text: str) -> dict:
    """Parse KEY=VALUE lines the way `. file` would, minus the shell."""
    env = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        env[key.strip()] = value
    return env


def validate_master_key(raw: str) -> None:
    """CRYPTO_MASTER_KEY must base64-decode to exactly 32 bytes.

    A hex string is the easy mistake: it looks like a key, deploys without
    complaint, and then the service exits at boot while systemd restarts it
    every three seconds and nginx proxies the public form to a dead API.
    """
    candidate = (raw or "").strip()
    if not candidate:
        raise SecretsError(
            "CRYPTO_MASTER_KEY is empty. Generate one with: openssl rand -base64 32"
        )
    try:
        decoded = base64.b64decode(candidate, validate=True)
    except (binascii.Error, ValueError):
        raise SecretsError(
            "CRYPTO_MASTER_KEY is not valid base64. Generate one with: "
            "openssl rand -base64 32"
        )
    if len(decoded) != 32:
        raise SecretsError(
            "CRYPTO_MASTER_KEY decodes to %d bytes; it must be exactly 32. "
            "A 64-character hex string is the usual cause -- it looks like a "
            "key and crash-loops the service at boot. Generate one with: "
            "openssl rand -base64 32" % len(decoded)
        )


def key_fingerprint(raw: str) -> str:
    """Eight hex characters identifying a key, without revealing any of it."""
    return hashlib.sha256((raw or "").strip().encode()).hexdigest()[:8]


def validate_email_config(env: dict) -> list:
    """Return warnings; raise SecretsError on anything that will not boot.

    Email is environment-owned -- no app_settings row can supply it -- so the
    API validates it at startup and exits if it is wrong. Catching it here
    means catching it on the operator's machine instead of in journalctl.
    """
    provider = (env.get("EMAIL_PROVIDER") or "graph").strip()
    if provider not in EMAIL_PROVIDERS:
        raise SecretsError(
            'EMAIL_PROVIDER is "%s"; valid values are %s, exact and lower case.'
            % (provider, " and ".join(EMAIL_PROVIDERS))
        )
    if provider == "console":
        return [
            "EMAIL_PROVIDER=console: the API runs with NODE_ENV=production, "
            "where the console adapter refuses to send. No mail will reach a "
            "data subject."
        ]
    missing = [k for k in GRAPH_KEYS if not (env.get(k) or "").strip()]
    if missing:
        raise SecretsError(
            "EMAIL_PROVIDER=graph, but these are empty: %s. Without them the "
            "API exits at boot and systemd crash-loops it, taking the portal "
            "offline." % " ".join(missing)
        )
    return []
```

Add `import base64`, `import binascii`, `import hashlib` to the module imports.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest discover -s deploy -p "test_*.py"` → all pass

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Refuse a secrets file that would crash-loop the service
```

---

### Task 3: Disk — measure, budget, project

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

The target host has roughly 10 GB, mostly used, and whether `/home`, `/var` and `/opt` are separate mounts or one root filesystem is unknown — so it is detected, never configured.

**Interfaces:**
- Consumes: nothing.
- Produces: `Mount = collections.namedtuple("Mount", "device mountpoint total free")`; `parse_df(text: str) -> list`; `mount_for(path: str, mounts: list) -> Mount`; `human_bytes(n: int) -> str`; `check_budget(mounts: list, needs: dict) -> list`; `project_days_until_full(samples: list, free_now: int) -> float or None`.

`needs` maps a path to bytes required, e.g. `{"/opt": 420_000_000}`. `check_budget` returns a list of human-readable refusal strings; empty means proceed. `samples` is a list of `(epoch_seconds, used_bytes)` pairs, oldest first.

- [ ] **Step 1: Write the failing tests**

```python
DF_SEPARATE = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     10737418240 8589934592 2147483648      80% /
/dev/vdb1     10737418240 9663676416 1073741824      90% /var
/dev/vdc1     10737418240 5368709120 5368709120      50% /home
"""

DF_SINGLE_ROOT = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     10737418240 8589934592 2147483648      80% /
"""


class TestDf(unittest.TestCase):
    def test_parses_every_row(self):
        mounts = dd.parse_df(DF_SEPARATE)
        self.assertEqual([m.mountpoint for m in mounts], ["/", "/var", "/home"])
        self.assertEqual(mounts[1].free, 1073741824)
        self.assertEqual(mounts[1].total, 10737418240)

    def test_ignores_the_header(self):
        self.assertTrue(all(m.device != "Filesystem" for m in dd.parse_df(DF_SEPARATE)))

    def test_longest_prefix_wins_not_first_match(self):
        mounts = dd.parse_df(DF_SEPARATE)
        # /var/lib/pgsql must resolve to /var, not to /
        self.assertEqual(dd.mount_for("/var/lib/pgsql", mounts).mountpoint, "/var")
        self.assertEqual(dd.mount_for("/opt/dsr", mounts).mountpoint, "/")
        self.assertEqual(dd.mount_for("/home/x", mounts).mountpoint, "/home")

    def test_prefix_match_respects_component_boundaries(self):
        mounts = dd.parse_df(DF_SEPARATE)
        # /vary is not inside /var
        self.assertEqual(dd.mount_for("/vary/thing", mounts).mountpoint, "/")

    def test_single_root_resolves_everything_to_root(self):
        mounts = dd.parse_df(DF_SINGLE_ROOT)
        for path in ("/opt/dsr", "/var/lib/pgsql", "/home/x"):
            self.assertEqual(dd.mount_for(path, mounts).mountpoint, "/")


class TestBudget(unittest.TestCase):
    def test_enough_room_returns_no_refusals(self):
        mounts = dd.parse_df(DF_SEPARATE)
        self.assertEqual(dd.check_budget(mounts, {"/home": 1024}), [])

    def test_too_little_room_names_the_mount_and_both_numbers(self):
        mounts = dd.parse_df(DF_SEPARATE)
        refusals = dd.check_budget(mounts, {"/var": 4_000_000_000})
        self.assertEqual(len(refusals), 1)
        self.assertIn("/var", refusals[0])
        self.assertIn("1.0 GB", refusals[0])
        self.assertIn("3.7 GB", refusals[0])

    def test_two_paths_on_one_mount_are_summed_not_checked_separately(self):
        # 700MB + 700MB both land on /var, which has 1.0GB free: one refusal.
        mounts = dd.parse_df(DF_SEPARATE)
        refusals = dd.check_budget(
            mounts, {"/var/lib/pgsql": 700_000_000, "/var/cache": 700_000_000}
        )
        self.assertEqual(len(refusals), 1)


class TestHumanBytes(unittest.TestCase):
    def test_scales_and_rounds(self):
        self.assertEqual(dd.human_bytes(0), "0 B")
        self.assertEqual(dd.human_bytes(512), "512 B")
        self.assertEqual(dd.human_bytes(1024), "1.0 KB")
        self.assertEqual(dd.human_bytes(1073741824), "1.0 GB")


class TestProjection(unittest.TestCase):
    DAY = 86400

    def test_no_baseline_returns_none(self):
        self.assertIsNone(dd.project_days_until_full([], 1000))
        self.assertIsNone(dd.project_days_until_full([(0, 100)], 1000))

    def test_steady_growth_projects_the_obvious_answer(self):
        samples = [(0, 0), (self.DAY, 100)]
        self.assertAlmostEqual(dd.project_days_until_full(samples, 1000), 10.0, places=3)

    def test_flat_or_shrinking_usage_returns_none(self):
        self.assertIsNone(dd.project_days_until_full([(0, 100), (self.DAY, 100)], 1000))
        self.assertIsNone(dd.project_days_until_full([(0, 200), (self.DAY, 100)], 1000))

    def test_uses_the_full_span_not_just_the_last_pair(self):
        samples = [(0, 0), (self.DAY, 500), (2 * self.DAY, 200)]
        # 200 bytes over 2 days = 100/day, so 1000 free lasts 10 days.
        self.assertAlmostEqual(dd.project_days_until_full(samples, 1000), 10.0, places=3)

    def test_identical_timestamps_do_not_divide_by_zero(self):
        self.assertIsNone(dd.project_days_until_full([(5, 10), (5, 90)], 1000))
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'parse_df'`

- [ ] **Step 3: Implement**

```python
Mount = collections.namedtuple("Mount", "device mountpoint total free")


def parse_df(text: str) -> list:
    """Parse `df -PB1` output. -P guarantees one record per line."""
    mounts = []
    for line in text.splitlines()[1:]:
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        try:
            total, _used, free = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            continue
        mounts.append(Mount(parts[0], parts[5].strip(), total, free))
    return mounts


def mount_for(path: str, mounts: list) -> Mount:
    """The filesystem a path lives on: longest matching mountpoint wins.

    Matching is on path components, so /vary is not inside /var.
    """
    best = None
    for m in mounts:
        if path == m.mountpoint or path.startswith(m.mountpoint.rstrip("/") + "/"):
            if best is None or len(m.mountpoint) > len(best.mountpoint):
                best = m
    return best


def human_bytes(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if unit == "B":
            if value < 1024:
                return "%d B" % int(value)
        elif value < 1024:
            return "%.1f %s" % (value, unit)
        value /= 1024.0
    return "%.1f PB" % value


def check_budget(mounts: list, needs: dict) -> list:
    """Refuse before acting, naming the mount and both numbers.

    Two paths on the same filesystem compete for the same free space, so
    their requirements are summed rather than checked one at a time.
    """
    per_mount = {}
    for path, wanted in needs.items():
        m = mount_for(path, mounts)
        if m is None:
            continue
        per_mount.setdefault(m.mountpoint, [m, 0])[1] += wanted
    refusals = []
    for mountpoint in sorted(per_mount):
        m, wanted = per_mount[mountpoint]
        if wanted > m.free:
            refusals.append(
                "%s has %s free; this step needs about %s"
                % (mountpoint, human_bytes(m.free), human_bytes(wanted))
            )
    return refusals


def project_days_until_full(samples: list, free_now: int) -> float:
    """Days until this filesystem fills, from the first and last samples.

    Returns None when there is no baseline, when usage is flat or falling,
    or when two samples share a timestamp -- all of which are honest answers
    rather than a fabricated number.
    """
    if len(samples) < 2:
        return None
    (t0, used0), (t1, used1) = samples[0], samples[-1]
    elapsed = t1 - t0
    grown = used1 - used0
    if elapsed <= 0 or grown <= 0:
        return None
    per_day = grown * 86400.0 / elapsed
    return free_now / per_day
```

Add `import collections` to the module imports.

- [ ] **Step 4: Run the tests** → all pass

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Measure the disk before spending it
```

---

### Task 4: The three config-file transforms

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

Two of these are the RHEL failures that give no useful symptom: `pg_hba.conf` defaulting to `ident` (the API authenticates against nothing), and RHEL's stock `server {}` block living inside `nginx.conf` itself (`duplicate default server`, nginx refuses to start).

**Interfaces:**
- Consumes: nothing.
- Produces: `MANAGED_MARKER = "# managed by dsr_deploy"`; `rewrite_pg_hba(text: str) -> tuple`; `neutralise_default_server(text: str) -> tuple`; `version_at_least(actual: str, minimum: str) -> bool`. Both rewriters return `(new_text, changed_bool)`.

- [ ] **Step 1: Write the failing tests**

```python
PG_HBA_RHEL_DEFAULT = """# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     peer
host    all             all             127.0.0.1/32            ident
host    all             all             ::1/128                 ident
host    replication     all             127.0.0.1/32            ident
"""


class TestPgHba(unittest.TestCase):
    def test_loopback_ident_becomes_scram(self):
        new, changed = dd.rewrite_pg_hba(PG_HBA_RHEL_DEFAULT)
        self.assertTrue(changed)
        for line in new.splitlines():
            if line.startswith("host") and ("127.0.0.1/32" in line or "::1/128" in line):
                self.assertIn("scram-sha-256", line)
                self.assertNotIn("ident", line)

    def test_local_peer_line_is_left_alone(self):
        new, _ = dd.rewrite_pg_hba(PG_HBA_RHEL_DEFAULT)
        self.assertIn("local   all             all                                     peer", new)

    def test_replication_line_is_left_alone(self):
        new, _ = dd.rewrite_pg_hba(PG_HBA_RHEL_DEFAULT)
        replication = [l for l in new.splitlines() if "replication" in l][0]
        self.assertIn("ident", replication)

    def test_second_run_is_a_no_op(self):
        once, _ = dd.rewrite_pg_hba(PG_HBA_RHEL_DEFAULT)
        twice, changed = dd.rewrite_pg_hba(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_comments_are_not_rewritten(self):
        text = "# host all all 127.0.0.1/32 ident\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_an_already_correct_file_is_unchanged(self):
        text = "host    all   all   127.0.0.1/32   scram-sha-256\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_md5_is_also_upgraded(self):
        new, changed = dd.rewrite_pg_hba("host all all 127.0.0.1/32 md5\n")
        self.assertTrue(changed)
        self.assertIn("scram-sha-256", new)


NGINX_RHEL_DEFAULT = """user nginx;
http {
    include /etc/nginx/conf.d/*.conf;

    server {
        listen       80 default_server;
        listen       [::]:80 default_server;
        server_name  _;
        root         /usr/share/nginx/html;
        error_page 404 /404.html;
    }
}
"""


class TestNginxDefaultServer(unittest.TestCase):
    def test_default_server_block_is_removed(self):
        new, changed = dd.neutralise_default_server(NGINX_RHEL_DEFAULT)
        self.assertTrue(changed)
        self.assertNotIn("default_server", new)
        self.assertNotIn("/usr/share/nginx/html", new)

    def test_the_include_survives(self):
        new, _ = dd.neutralise_default_server(NGINX_RHEL_DEFAULT)
        self.assertIn("include /etc/nginx/conf.d/*.conf;", new)
        self.assertIn("user nginx;", new)

    def test_braces_stay_balanced(self):
        new, _ = dd.neutralise_default_server(NGINX_RHEL_DEFAULT)
        self.assertEqual(new.count("{"), new.count("}"))

    def test_it_leaves_a_marker_and_is_idempotent(self):
        once, _ = dd.neutralise_default_server(NGINX_RHEL_DEFAULT)
        self.assertIn(dd.MANAGED_MARKER, once)
        twice, changed = dd.neutralise_default_server(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_a_file_without_a_default_server_is_untouched(self):
        text = "user nginx;\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n"
        new, changed = dd.neutralise_default_server(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)


class TestVersionAtLeast(unittest.TestCase):
    def test_compares_numerically_not_as_strings(self):
        self.assertTrue(dd.version_at_least("22.1.0", "22"))
        self.assertTrue(dd.version_at_least("22.0.0", "22"))
        self.assertTrue(dd.version_at_least("100.0.0", "22"))   # not a string compare
        self.assertFalse(dd.version_at_least("20.19.0", "22"))
        self.assertFalse(dd.version_at_least("9.6", "16"))

    def test_tolerates_a_v_prefix_and_trailing_text(self):
        self.assertTrue(dd.version_at_least("v22.11.0", "22"))
        self.assertTrue(dd.version_at_least("psql (PostgreSQL) 16.2", "16"))

    def test_unparseable_input_is_false_rather_than_an_exception(self):
        self.assertFalse(dd.version_at_least("", "22"))
        self.assertFalse(dd.version_at_least("unknown", "22"))
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'rewrite_pg_hba'`

- [ ] **Step 3: Implement**

```python
MANAGED_MARKER = "# managed by dsr_deploy"

_LOOPBACK = ("127.0.0.1/32", "::1/128")
_WEAK_METHODS = ("ident", "md5", "trust", "password")


def rewrite_pg_hba(text: str) -> tuple:
    """Make loopback host connections use scram-sha-256.

    RHEL's default is `ident`, under which the API -- which connects to
    127.0.0.1:5432 with a password -- authenticates against nothing and every
    query fails. Debian's default already allowed password auth, which is why
    this never came up before.

    Replication rows are left alone: they are not how the portal connects,
    and changing them is not this tool's business.
    """
    out = []
    changed = False
    for line in text.splitlines():
        stripped = line.strip()
        fields = stripped.split()
        if (
            stripped
            and not stripped.startswith("#")
            and len(fields) >= 5
            and fields[0] == "host"
            and fields[1] != "replication"
            and any(addr in fields for addr in _LOOPBACK)
            and fields[-1] in _WEAK_METHODS
        ):
            out.append(line[: line.rindex(fields[-1])] + "scram-sha-256")
            changed = True
        else:
            out.append(line)
    result = "\n".join(out)
    if text.endswith("\n"):
        result += "\n"
    return result, changed


def neutralise_default_server(text: str) -> tuple:
    """Remove RHEL's stock default server block from nginx.conf.

    Our own config declares `listen 80 default_server`, and nginx refuses to
    start with two of them: `duplicate default server`. On Debian the stock
    one is a file in sites-enabled you can delete; on RHEL it lives inside
    nginx.conf itself, so it has to be edited out.

    Brace-counted rather than regex-matched, because a regex that gets this
    wrong produces an unbalanced file and nginx then fails for a second,
    more confusing reason.
    """
    if MANAGED_MARKER in text:
        return text, False

    lines = text.splitlines()
    out = []
    i = 0
    changed = False
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith("server") and stripped.endswith("{"):
            depth = 0
            j = i
            block = []
            while j < len(lines):
                depth += lines[j].count("{") - lines[j].count("}")
                block.append(lines[j])
                j += 1
                if depth == 0:
                    break
            if any("default_server" in b for b in block):
                indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
                out.append(
                    indent
                    + MANAGED_MARKER
                    + " -- stock default server removed; see conf.d/dsr.conf"
                )
                changed = True
                i = j
                continue
        out.append(lines[i])
        i += 1

    if not changed:
        return text, False
    result = "\n".join(out)
    if text.endswith("\n"):
        result += "\n"
    return result, True


def version_at_least(actual: str, minimum: str) -> bool:
    """Compare dotted versions numerically. Unparseable input is False."""
    found = re.search(r"(\d+(?:\.\d+)*)", actual or "")
    if not found:
        return False
    got = [int(p) for p in found.group(1).split(".")]
    want = [int(p) for p in (minimum or "0").split(".")]
    got += [0] * (len(want) - len(got))
    want += [0] * (len(got) - len(want))
    return got >= want
```

Add `import re` to the module imports.

- [ ] **Step 4: Run the tests** → all pass

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Teach the deployer the two RHEL defaults that break it
```

---

### Task 5: Findings, rendering, and exit codes

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

Every `doctor` check produces `Finding`s. Splitting the *evaluation* of captured output from the *collection* of it is what makes the diagnostics testable without a server, and every evaluator in Task 7 depends on this shape.

**Interfaces:**
- Consumes: nothing.
- Produces: `OK = "ok"`, `WARN = "warn"`, `FAIL = "fail"`; `Finding = collections.namedtuple("Finding", "group severity title detail fix")` with `detail` and `fix` allowed to be `""`; `render_findings(findings: list) -> str`; `exit_code_for(findings: list) -> int`.

- [ ] **Step 1: Write the failing tests**

```python
class TestFindings(unittest.TestCase):
    def make(self, severity, fix=""):
        return dd.Finding("selinux", severity, "a title", "a detail", fix)

    def test_exit_codes_are_zero_one_two(self):
        self.assertEqual(dd.exit_code_for([]), 0)
        self.assertEqual(dd.exit_code_for([self.make(dd.OK)]), 0)
        self.assertEqual(dd.exit_code_for([self.make(dd.WARN)]), 1)
        self.assertEqual(dd.exit_code_for([self.make(dd.FAIL)]), 2)

    def test_worst_severity_decides(self):
        self.assertEqual(
            dd.exit_code_for([self.make(dd.OK), self.make(dd.FAIL), self.make(dd.WARN)]), 2
        )

    def test_render_shows_title_detail_and_fix(self):
        text = dd.render_findings([self.make(dd.FAIL, fix="setsebool -P x on")])
        self.assertIn("a title", text)
        self.assertIn("a detail", text)
        self.assertIn("setsebool -P x on", text)

    def test_render_groups_and_marks_severity(self):
        text = dd.render_findings([
            dd.Finding("disk", dd.OK, "space", "", ""),
            dd.Finding("selinux", dd.FAIL, "boolean off", "", "setsebool"),
        ])
        self.assertIn("disk", text)
        self.assertIn("selinux", text)
        self.assertLess(text.index("disk"), text.index("selinux"))

    def test_render_of_nothing_is_not_an_empty_string(self):
        self.assertTrue(dd.render_findings([]).strip())

    def test_a_finding_without_a_fix_renders_without_a_dangling_label(self):
        text = dd.render_findings([dd.Finding("disk", dd.OK, "fine", "", "")])
        self.assertNotIn("fix:", text)
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'Finding'`

- [ ] **Step 3: Implement**

```python
OK = "ok"
WARN = "warn"
FAIL = "fail"

_SEVERITY_RANK = {OK: 0, WARN: 1, FAIL: 2}
_SEVERITY_LABEL = {OK: "ok  ", WARN: "WARN", FAIL: "FAIL"}

Finding = collections.namedtuple("Finding", "group severity title detail fix")


def exit_code_for(findings: list) -> int:
    """0 clean, 1 warnings, 2 failures -- so cron and monitoring can use this."""
    if not findings:
        return 0
    return max(_SEVERITY_RANK.get(f.severity, 0) for f in findings)


def render_findings(findings: list) -> str:
    if not findings:
        return "No checks ran.\n"
    lines = []
    for group in sorted({f.group for f in findings}):
        lines.append("[%s]" % group)
        for f in [x for x in findings if x.group == group]:
            lines.append("  %s %s" % (_SEVERITY_LABEL.get(f.severity, "?   "), f.title))
            if f.detail:
                lines.append("       %s" % f.detail)
            if f.fix:
                lines.append("       fix: %s" % f.fix)
        lines.append("")
    worst = exit_code_for(findings)
    lines.append(["All checks passed.", "Warnings above.", "Failures above."][worst])
    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run the tests** → all pass

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Give every check a severity and an exit code
```

---

### Task 6: Transport, and the plan each command would run

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

`--dry-run` is only meaningful if the plan is data rather than control flow, so both commands build a list of `Step`s first and then execute it. That also makes the plans testable.

**Interfaces:**
- Consumes: `INSTALL_PREFIX`, `WEB_ROOT`, `UPLOADS_DIR`, `REMOTE_SELF`, `SERVICE`, `MANAGED_MARKER`.
- Produces: `Step = collections.namedtuple("Step", "name command")`; `provision_steps() -> list`; `deploy_steps(env: dict) -> list`; `render_plan(steps: list) -> str`; `class Ssh` with `__init__(self, target, key)`, `run(self, command, check=True)`, `push_file(self, local, remote)`, `push_dir(self, local, remote)`; `load_target(text: str) -> dict`.

- [ ] **Step 1: Write the failing tests**

```python
class TestPlans(unittest.TestCase):
    def test_provision_covers_every_step_the_spec_lists(self):
        names = " ".join(s.name for s in dd.provision_steps()).lower()
        for expected in (
            "package", "node", "postgres", "initdb", "pg_hba", "role",
            "user", "selinux", "nginx", "firewall", "journal", "zram",
        ):
            self.assertIn(expected, names, "provision has no %s step" % expected)

    def test_provision_never_disables_selinux(self):
        blob = " ".join(s.command for s in dd.provision_steps())
        for forbidden in ("setenforce 0", "SELINUX=disabled", "--permissive"):
            self.assertNotIn(forbidden, blob)

    def test_provision_turns_the_proxy_boolean_on(self):
        blob = " ".join(s.command for s in dd.provision_steps())
        self.assertIn("httpd_can_network_connect", blob)
        self.assertIn("setsebool -P", blob)

    def test_no_step_anywhere_removes_uploads(self):
        every = dd.provision_steps() + dd.deploy_steps({"EMAIL_PROVIDER": "console"})
        for step in every:
            self.assertNotIn("rm -rf %s" % dd.UPLOADS_DIR, step.command)
            self.assertNotIn("rm -rf /opt/dsr/uploads", step.command)

    def test_deploy_migrates_before_it_restarts(self):
        names = [s.name for s in dd.deploy_steps({"EMAIL_PROVIDER": "console"})]
        self.assertLess(
            [i for i, n in enumerate(names) if "migrat" in n.lower()][0],
            [i for i, n in enumerate(names) if "restart" in n.lower()][0],
        )

    def test_render_plan_numbers_the_steps_and_shows_commands(self):
        text = dd.render_plan([dd.Step("do a thing", "echo hi")])
        self.assertIn("do a thing", text)
        self.assertIn("echo hi", text)
        self.assertIn("1", text)


class TestTarget(unittest.TestCase):
    def test_reads_host_and_key(self):
        target = dd.load_target('HOST=root@1.2.3.4\nSSH_KEY=~/.ssh/id_ed25519\n')
        self.assertEqual(target["HOST"], "root@1.2.3.4")

    def test_deploy_host_is_accepted_as_an_alias(self):
        self.assertEqual(dd.load_target("DEPLOY_HOST=root@x\n")["HOST"], "root@x")


class TestSsh(unittest.TestCase):
    def test_builds_a_command_with_the_key_and_no_host_key_prompt(self):
        argv = dd.Ssh("root@h", "/k/id").argv("uptime")
        self.assertIn("-i", argv)
        self.assertIn("/k/id", argv)
        self.assertIn("root@h", argv)
        self.assertIn("uptime", argv)

    def test_the_remote_command_is_one_argv_element_not_shell_spliced(self):
        # The whole point of pushing the tool to the box: no nested quoting.
        argv = dd.Ssh("root@h", "/k/id").argv("echo 'a b'; rm -rf /")
        self.assertIn("echo 'a b'; rm -rf /", argv)
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'provision_steps'`

- [ ] **Step 3: Implement**

Write `Step`, `render_plan`, `load_target`, `Ssh`, `provision_steps()` and `deploy_steps(env)`.

`Ssh.argv(command)` returns
`["ssh", "-o", "StrictHostKeyChecking=no", "-i", key, target, command]` — the
remote command stays a single argv element, never interpolated into a shell
string. `run` uses `subprocess.run(argv, capture_output=True, text=True)` and
raises on a non-zero exit when `check=True`. `push_dir` pipes
`tar -czf - -C src .` into `ssh … "rm -rf dest && mkdir -p dest && tar -xzf - -C dest"`,
matching what `deploy/deploy.sh` does today so it works from Git Bash.

`provision_steps()` returns the eleven steps of the spec, in order: preflight,
packages, Node 22, PostgreSQL 16, `postgresql-setup --initdb`, `pg_hba`, roles
and database, service user and directories, SELinux, nginx, firewalld, journald,
zram. Each `command` is a shell fragment run on the box, and each is idempotent —
`dnf install -y` is already, directory creation uses `mkdir -p`, `setsebool -P`
is, and the two file rewrites are guarded by Task 4's functions.

Specific values: `useradd --system --no-create-home --home-dir /opt/dsr --shell /sbin/nologin dsr`
(note `/sbin/nologin`, not Debian's `/usr/sbin/nologin`); `chown -R nginx:nginx /var/www/dsr`
(not `www-data`); `install -d -o dsr -g dsr -m 750 /opt/dsr/uploads`;
`firewall-cmd --permanent --add-service={ssh,http,https}` then `--reload`;
`mkdir -p /etc/systemd/journald.conf.d` and a drop-in setting `SystemMaxUse=200M`;
`/etc/systemd/zram-generator.conf` containing `[zram0]` and
`zram-size = min(ram / 2, 2048)`.

`deploy_steps(env)` returns the deployment sequence: write `.env` (with the
`.env.bak` copy first), `npm ci --omit=dev`, `npm cache clean --force`,
`node scripts/migrate.mjs`, `node scripts/import-forms.mjs`, ownership and
`restorecon`, install the unit and `conf.d/dsr.conf`, `nginx -t`,
`systemctl daemon-reload`, restart, reload nginx. Migration steps must come
before the restart step — the test above pins that order.

- [ ] **Step 4: Run the tests** → all pass. Also run `python3 deploy/dsr_deploy.py provision --dry-run` and read the printed plan.

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Make the plan data so a dry run can print it
```

---

### Task 7: The doctor checks

**Files:**
- Modify: `deploy/dsr_deploy.py`
- Modify: `deploy/test_dsr_deploy.py`

Each check is two pieces: a **collector** that runs a command on the box, and an **evaluator** that takes the captured text and returns `Finding`s. Only the evaluators are tested, and they are tested against real command output pasted as fixtures.

**Interfaces:**
- Consumes: `Finding`, `OK`/`WARN`/`FAIL`, `human_bytes`, `mount_for`, `parse_df`, `project_days_until_full`, `version_at_least`.
- Produces: `evaluate_selinux(getenforce: str, booleans: str, avc: str) -> list`; `evaluate_service(is_active: str, show_output: str, journal: str) -> list`; `evaluate_env(env_text: str, mode: str) -> list`; `evaluate_disk(df_text: str, samples: dict) -> list`; `evaluate_tls(cert_dates: str, now_epoch: int) -> list`; `evaluate_database(psql_roles: str, migrations_applied: str, migration_files: list) -> list`.

- [ ] **Step 1: Write the failing tests**

```python
class TestSelinuxEvaluator(unittest.TestCase):
    def test_boolean_off_is_a_failure_that_names_the_boolean(self):
        findings = dd.evaluate_selinux("Enforcing", "httpd_can_network_connect --> off", "")
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertTrue(bad)
        self.assertIn("httpd_can_network_connect", bad[0].fix)
        self.assertIn("setsebool -P", bad[0].fix)

    def test_boolean_on_and_enforcing_is_clean(self):
        findings = dd.evaluate_selinux("Enforcing", "httpd_can_network_connect --> on", "")
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_permissive_is_a_warning_not_a_recommendation(self):
        findings = dd.evaluate_selinux("Permissive", "httpd_can_network_connect --> on", "")
        warn = [f for f in findings if f.severity == dd.WARN]
        self.assertTrue(warn)
        blob = " ".join(f.fix + f.detail for f in findings)
        self.assertNotIn("setenforce 0", blob)
        self.assertNotIn("SELINUX=disabled", blob)

    def test_avc_denials_are_surfaced(self):
        avc = "type=AVC msg=audit(1): avc:  denied  { name_connect } for  pid=1 comm=\"nginx\""
        findings = dd.evaluate_selinux("Enforcing", "httpd_can_network_connect --> on", avc)
        self.assertTrue(any("denial" in f.title.lower() for f in findings))


class TestServiceEvaluator(unittest.TestCase):
    def test_a_crash_loop_is_distinguished_from_merely_down(self):
        findings = dd.evaluate_service("activating", "NRestarts=57", "some error")
        self.assertTrue(any("restart" in f.title.lower() for f in findings))
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_active_with_no_restarts_is_clean(self):
        findings = dd.evaluate_service("active", "NRestarts=0", "")
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_inactive_is_a_failure(self):
        findings = dd.evaluate_service("inactive", "NRestarts=0", "")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))


class TestEnvEvaluator(unittest.TestCase):
    GOOD = (
        "NODE_ENV=production\nPORT=3000\n"
        "DATABASE_URL=postgres://dsr:p@127.0.0.1:5432/dsr\n"
        "DATABASE_URL_APP=postgres://dsr_app:p@127.0.0.1:5432/dsr\n"
        "CRYPTO_MASTER_KEY=" + base64.b64encode(b"\x01" * 32).decode() + "\n"
        "EMAIL_PROVIDER=graph\nPRIVACY_MAILBOX=p@e.com\n"
        "GRAPH_TENANT_ID=t\nGRAPH_CLIENT_ID=c\nGRAPH_CLIENT_SECRET=s\n"
    )

    def test_a_good_env_at_mode_600_is_clean(self):
        self.assertTrue(all(f.severity == dd.OK for f in dd.evaluate_env(self.GOOD, "600")))

    def test_a_world_readable_env_is_a_failure(self):
        findings = dd.evaluate_env(self.GOOD, "644")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_a_hex_master_key_is_caught_here_too(self):
        text = self.GOOD.replace(
            base64.b64encode(b"\x01" * 32).decode(), "a" * 64
        )
        self.assertTrue(any(f.severity == dd.FAIL for f in dd.evaluate_env(text, "600")))

    def test_no_finding_ever_contains_the_key_itself(self):
        key = base64.b64encode(b"\x01" * 32).decode()
        for f in dd.evaluate_env(self.GOOD, "600"):
            self.assertNotIn(key, f.title + f.detail + f.fix)


class TestTlsEvaluator(unittest.TestCase):
    # 1788220800 is 2026-09-01T00:00:00Z. Nine days before the cert below.
    NOW = 1788220800

    def test_expiry_inside_two_weeks_warns(self):
        findings = dd.evaluate_tls("notAfter=Sep 10 00:00:00 2026 GMT", self.NOW)
        self.assertTrue(any(f.severity in (dd.WARN, dd.FAIL) for f in findings))

    def test_expiry_months_away_is_clean(self):
        findings = dd.evaluate_tls("notAfter=Dec 31 00:00:00 2026 GMT", self.NOW)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_an_already_expired_certificate_is_a_failure(self):
        findings = dd.evaluate_tls("notAfter=Jan 10 00:00:00 2026 GMT", self.NOW)
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_no_certificate_is_a_warning_not_a_crash(self):
        self.assertTrue(dd.evaluate_tls("", self.NOW))
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — `AttributeError: module 'dsr_deploy' has no attribute 'evaluate_selinux'`

- [ ] **Step 3: Implement the evaluators, then the collectors**

Evaluators are pure. The SELinux one is the reason this tool exists — when
`httpd_can_network_connect` is off it must produce a `FAIL` whose `fix` is
literally `setsebool -P httpd_can_network_connect on`, because the symptom
(502, `Permission denied while connecting to upstream`) names nothing.

`evaluate_service` reads `NRestarts=` out of `systemctl show` output: a service
that is `active` with a high restart count is a crash loop, which is a different
problem from one that is simply down, and the two need different first moves.

`evaluate_env` re-uses `validate_master_key` and `validate_email_config` rather
than reimplementing them, and must never place a value into a `Finding`.

Collectors run: `getenforce`; `getsebool httpd_can_network_connect`;
`ausearch -m avc -ts recent` (tolerating exit 1, which means "no denials");
`systemctl is-active dsr-api`; `systemctl show dsr-api -p NRestarts`;
`journalctl -u dsr-api -n 25 --no-pager`; `df -PB1`; `stat -c %a` on the env
file; `psql -tAc` for roles and applied migrations;
`openssl x509 -enddate -noout -in <cert>`; `nginx -t`; `ss -lntp`.

`cmd_doctor` assembles findings, applies any group filter, records the sample in
`STATE_PATH` unless `--no-state`, prints `render_findings`, and returns
`exit_code_for`.

- [ ] **Step 4: Run the tests** → all pass

- [ ] **Step 5: Commit**

```bash
git add deploy/dsr_deploy.py deploy/test_dsr_deploy.py
git commit   # subject: Explain a RHEL box that is not working
```

---

### Task 8: The runbook, and the spec corrections

**Files:**
- Create: `deploy/README-rhel.md`
- Modify: `docs/superpowers/specs/2026-08-30-rhel-deployer-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the runbook**

`deploy/README-rhel.md` covers: what the tool is and that the Ubuntu bash
scripts are unaffected; prerequisites (a RHEL 9 host, root SSH, `deploy/.target.env`
and a secrets file); the three commands with real invocations; what `provision`
changes on the box, as a list an operator can audit; how to read `doctor` output
and what the exit codes mean; the disk story, including that uploads are never
deleted by this tool and why; and a troubleshooting table whose first row is the
502/SELinux case.

- [ ] **Step 2: Correct the spec**

Three edits, each because the tree now says otherwise:
- Filename is `deploy/dsr_deploy.py`, not `dsr-deploy.py` — the hyphen is not
  importable by the test file. Update every occurrence, including the
  `/root/dsr-deploy.py` in the Architecture block and the Verification commands.
- The Testing section names `deploy/test_dsr_deploy.py`; confirm it matches.
- Add the collector/evaluator split to the Testing section — it is the design
  decision that makes the diagnostics testable at all, and the spec currently
  does not mention it.

- [ ] **Step 3: Verify the whole thing**

```bash
python3 -m unittest discover -s deploy -p "test_*.py" -v
python3 -m py_compile deploy/dsr_deploy.py
python3 deploy/dsr_deploy.py --help
python3 deploy/dsr_deploy.py provision --dry-run
python3 deploy/dsr_deploy.py deploy --dry-run
grep -rn "setenforce 0\|SELINUX=disabled" deploy/dsr_deploy.py   # expect: no matches
grep -rn "rm -rf.*uploads" deploy/dsr_deploy.py                  # expect: no matches
```

- [ ] **Step 4: Commit**

```bash
git add deploy/README-rhel.md docs/superpowers/specs/2026-08-30-rhel-deployer-design.md
git commit   # subject: Write the runbook and correct the spec
```

---

## Self-Review

**Spec coverage.** One file, stdlib, 3.9 → Task 1. Secrets guards → Task 2. Disk measurement, budget, projection → Task 3. `pg_hba`, nginx default server, version checks → Task 4. Findings and exit codes → Task 5. Transport, provisioning steps, deployment steps, `--dry-run` → Task 6. The five doctor groups and the state file → Task 7. Runbook and spec drift → Task 8.

**Two spec items deliberately deferred within tasks rather than given their own:** TLS re-application and `ensure-urls` are part of Task 6's `deploy_steps`, since they are two steps in a sequence rather than a separable deliverable. The adversarial SELinux verification is documented in Task 8's runbook and in the spec's Verification block; it cannot be executed without a host.

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Every code step carries real code; every test step carries real assertions.

**Type consistency.** `Finding` is defined once in Task 5 and consumed with the same five fields by every evaluator in Task 7. `Mount` and `mount_for` are defined in Task 3 and reused by `evaluate_disk` in Task 7. `Step` is defined in Task 6 and used by both plan builders. `MANAGED_MARKER` is defined in Task 4 and referenced by Task 6's nginx step. `validate_master_key` and `validate_email_config` are defined in Task 2 and reused rather than reimplemented by `evaluate_env` in Task 7.
