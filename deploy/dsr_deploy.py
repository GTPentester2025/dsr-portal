#!/usr/bin/env python3
"""Deploy the DSR portal on this RHEL 9 host, in one command.

Run it on the server, as root, from the repository you cloned there:

    sudo python3 deploy/dsr_deploy.py

That is the whole invocation. It provisions the host, builds the bundles,
installs them, runs the migrations, restarts the API, waits for it to
answer, and then runs every diagnostic check as a final verification. Ten
numbered steps, so a failure says how far it got:

     1  Preflight -- root, RHEL 9, a complete checkout, a log to write to
     2  What else is on this box -- every other TCP listener, and the exact
        command to stop each one. Nothing is stopped for you.
     3  Secrets -- read /opt/dsr/server/.env, keep every value in it, and
        generate only what is genuinely missing
     4  Disk space for the packages
     5  Provision -- PostgreSQL 16, Node 22, nginx, firewalld, SELinux,
        zram, the pg_hba rewrite, the service user and directories
     6  Build -- npm run build in server, apps/admin, apps/public-form
     7  Disk space for the deployment
     8  Install the built bundles into /opt/dsr and /var/www/dsr
     9  Deploy -- write .env, npm ci, migrate, import forms, install the
        unit and the nginx site, restart, reload
    10  Health check, then the checks

Three flags, and no subcommands:

    --diagnose     run the checks only; change nothing
    --reset-admin  set a fresh administrator password and print it
    --dry-run      print the plan; touch nothing
    --skip-build   reuse whatever is already in dist/

Secrets. The two database passwords and the settings encryption key are
generated here and never typed: nobody uses them but the portal talking to
itself. CRYPTO_MASTER_KEY is generated ONCE, on the deployment that finds no
.env, and read back unchanged on every deployment after it -- a second one
makes every encrypted row in app_settings permanently unreadable. The only
thing an operator supplies is the four Microsoft Graph mail credentials, in
deploy/.secrets.env, which this writes as a commented template if it is not
there.

Every run is logged to /var/log/dsr-deploy/deploy-<date>.log -- each step's
command, exit code and output, with the secrets filtered out of every line,
because that file exists to be sent to somebody for help. The last ten are
kept.

This box may be running something else. DSR's nginx site claims port 80, so
any other site in /etc/nginx/conf.d is MOVED ASIDE into a timestamped
directory, printed as it goes, with the one command that puts it all back.
No service is ever stopped: step 2 prints what is running and leaves that
decision with the person who knows the box.

Targets the Python RHEL 9 ships (3.9). Standard library only -- there is no
pip install step.
"""
from __future__ import annotations

import base64
import binascii
import calendar
import collections
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import secrets as secrets_module
import subprocess
import sys
import tempfile
import time
# The stdlib `secrets` module, imported by name because `secrets` is also
# what every function here calls the parsed environment it is handed, and a
# shadowed module is a NameError that only fires on the one path that
# generates a password.
from secrets import token_bytes, token_hex
from urllib.parse import urlsplit

INSTALL_PREFIX = "/opt/dsr"
WEB_ROOT = "/var/www/dsr"
UPLOADS_DIR = "/opt/dsr/uploads"
ENV_PATH = "/opt/dsr/server/.env"
# A copy of this file, kept where the steps can find it. /root rather than
# the install prefix: the copy is made before /opt/dsr or the dsr user
# exist, and the run is root's either way. Two provisioning steps invoke
# `python3 /root/dsr_deploy.py` to reuse the pg_hba and nginx transforms
# rather than re-deriving them in sed, so this copy is load bearing.
REMOTE_SELF = "/root/dsr_deploy.py"
# Where the secret values a step needs are staged, mode 0600 and deleted
# when the run ends. A file rather than a `DB_PASS=... command` prefix
# because the second form puts the password in the process table for
# anyone with `ps` to read.
REMOTE_SECRETS = "/root/.dsr-secrets.env"
STATE_PATH = "/var/lib/dsr-deploy/state.json"
# Where the last run put the nginx sites it displaced. Written by the
# displacement step and read by the rollback inside the install step, so a
# config this tool could not validate never leaves the box serving nothing.
DISPLACED_MARKER = "/var/lib/dsr-deploy/displaced-nginx-conf"
SERVICE = "dsr-api"
APP_PORT = 3000

# Files this tool ships alongside itself and pushes to the box verbatim.
_DEPLOY_DIR = pathlib.Path(__file__).resolve().parent
NGINX_CONF_LOCAL = _DEPLOY_DIR / "nginx.conf"
UNIT_FILE_LOCAL = _DEPLOY_DIR / "dsr-api.service"

# Where things live on a RHEL 9 box specifically -- these paths differ from
# Debian's (which uses /etc/nginx/sites-available and a cluster-versioned
# postgresql data directory).
PG_HBA_REMOTE = "/var/lib/pgsql/data/pg_hba.conf"
NGINX_MAIN_CONF_REMOTE = "/etc/nginx/nginx.conf"
NGINX_SITE_CONF_REMOTE = "/etc/nginx/conf.d/dsr.conf"
UNIT_REMOTE = "/etc/systemd/system/%s.service" % SERVICE

MIN_PYTHON = (3, 9)


class Refusal(Exception):
    """A precondition that stops a run, ideally before anything is pushed.

    Refusing with the numbers -- which mount, how much free, how much
    needed, which fingerprint -- is the difference between a five minute
    fix and an afternoon. Failing halfway through a deployment is not.
    """


class SecretsError(Refusal):
    """A secrets or target file that would break the portal if deployed."""


EMAIL_PROVIDERS = ("graph", "console")
# The two postgres roles the portal logs in as. Both must be set: see
# validate_role_passwords for what an empty one costs.
ROLE_PASSWORD_KEYS = ("DB_PASS", "APP_PASS")
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
    # The length check is what catches the documented incident, not the
    # format check above it: a 64-character hex string is valid base64 and
    # decodes cleanly to 48 bytes, so it never reaches the binascii.Error
    # branch. Delete this and the original bug comes back.
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


def key_fingerprint_or_blank(raw: str) -> str:
    """The fingerprint of a key, or "" when there is no key at all.

    key_fingerprint("") is a perfectly good hash of nothing. Handing it to
    fingerprint_refusal as "what is already installed" would mismatch every
    real key and refuse every first deployment, so absence has to stay
    distinguishable from a hash.
    """
    raw = (raw or "").strip()
    return key_fingerprint(raw) if raw else ""


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
    """Bytes as a binary-unit string, labelled for the divisor it uses.

    The arithmetic is 1024-based, so the labels have to be MiB and GiB. As
    MB and GB they disagreed with the constants they came from: DEPLOY_BYTES
    is 420 * 1000 * 1000 and printed "400.5 MB", and the breakdown read
    "node_modules ~295.6 MB" where the constant says 310 MB. The refusal an
    operator reads then disagrees with both the spec and the source.

    MiB/GiB is also what `df -h` prints on the box, which is where the
    refusal sends them next.
    """
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if unit == "B":
            if value < 1024:
                return "%d B" % int(value)
        elif value < 1024:
            return "%.1f %s" % (value, unit)
        value /= 1024.0
    return "%.1f PiB" % value


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


MANAGED_MARKER = "# managed by dsr_deploy"
PG_HBA_MARKER = (
    MANAGED_MARKER + " -- loopback host rules set to scram-sha-256; "
    "the file as it was is beside this one, as pg_hba.conf.orig"
)

# Loopback, written every way pg_hba accepts. `localhost` and `samehost` are
# names postgres resolves itself, and a rule using either is as much the
# API's connection as 127.0.0.1 is.
_LOOPBACK_ADDRESSES = ("127.0.0.1", "::1", "localhost", "samehost")

# Every method pg_hba.conf recognises. The list exists so the method can be
# found by what it is rather than by where it sits: `fields[-1]` is the
# method only when nothing follows it, and a trailing comment or a
# `clientcert=verify-full` option both put something there.
_AUTH_METHODS = (
    "trust", "reject", "scram-sha-256", "md5", "password", "gss", "sspi",
    "ident", "peer", "ldap", "radius", "cert", "pam", "bsd",
)
_WEAK_METHODS = ("ident", "md5", "trust", "password")

# The address field is index 3; the method is at 4 or later depending on
# whether the rule uses CIDR or the older `address netmask` pair.
_ADDRESS_FIELD = 3

# Every TCP connection type pg_hba.conf accepts. `local` is a unix socket
# and stays on peer; the portal connects over TCP to 127.0.0.1.
#
# hostgssenc and hostnogssenc are here because they are host rules too: on a
# box where one of them covers 127.0.0.1 with `ident`, leaving it alone
# leaves the API authenticating against nothing, which is the exact failure
# the rewrite exists to prevent.
_HOST_TYPES = ("host", "hostssl", "hostnossl", "hostgssenc", "hostnogssenc")


def _split_comment(line: str) -> tuple:
    """(code, comment) at the first `#`. pg_hba has no quoting that survives
    one, so the first is the only one that matters."""
    index = line.find("#")
    if index < 0:
        return line, ""
    return line[:index], line[index:]


def _is_loopback(field: str) -> bool:
    """Loopback with or without a prefix length: 127.0.0.1, 127.0.0.1/32,
    ::1, ::1/128, localhost, samehost."""
    return field.split("/")[0].strip().lower() in _LOOPBACK_ADDRESSES


def _method_index(fields: list) -> int:
    """Index of the auth method, found by name rather than by position.

    Scanning from the address field onward tolerates both the CIDR form
    (`127.0.0.1/32 ident`) and the netmask pair (`127.0.0.1 255.255.255.255
    ident`) without needing to know which it is looking at, and it does not
    mistake a trailing option for the method. Scanning starts past the
    database and user fields so a database literally named `ident` cannot be
    read as one.
    """
    for index in range(_ADDRESS_FIELD + 1, len(fields)):
        if fields[index].lower() in _AUTH_METHODS:
            return index
    return -1


def _replace_field(text: str, index: int, replacement: str) -> str:
    """Swap the index-th whitespace-separated token, keeping every space."""
    pieces = re.split(r"(\s+)", text)
    seen = -1
    for position, piece in enumerate(pieces):
        if piece and not piece.isspace():
            seen += 1
            if seen == index:
                pieces[position] = replacement
                break
    return "".join(pieces)


def rewrite_pg_hba(text: str) -> tuple:
    """Make loopback host connections use scram-sha-256.

    RHEL's default is `ident`, under which the API -- which connects to
    127.0.0.1:5432 with a password -- authenticates against nothing and every
    query fails. Debian's default already allowed password auth, which is why
    this never came up before.

    Every shape of rule this misses fails the same silent way: the rule stays
    on `ident`, the portal boots, and then it cannot read its own database.
    So the parsing is deliberately tolerant -- an inline comment is stripped
    before anything else is read, loopback is recognised by address rather
    than by an exact string, and the method is found by name rather than by
    being last on the line.

    All three TCP connection types count. A box whose loopback rules read
    `hostssl` rather than `host` -- ordinary where TLS is required on the
    wire -- kept `ident` under the earlier match, and then failed in exactly
    the way this function exists to prevent.

    Replication rows are left alone: they are not how the portal connects,
    and changing them is not this tool's business.

    A changed file gets MANAGED_MARKER as its first line, and a file that
    already carries the marker is returned untouched. Idempotency was
    already held by a different mechanism -- scram-sha-256 is not in the
    weak-method set, so a second pass matches nothing -- so what the marker
    adds is the operator-facing half the spec asks for: without it nothing
    in pg_hba.conf says this tool edited it, and the .orig beside it is the
    only clue.
    """
    if MANAGED_MARKER in text:
        return text, False

    out = []
    changed = False
    for line in text.splitlines():
        code, comment = _split_comment(line)
        fields = code.split()
        if (
            code.strip()
            and len(fields) > _ADDRESS_FIELD + 1
            and fields[0].lower() in _HOST_TYPES
            and fields[1] != "replication"
            and _is_loopback(fields[_ADDRESS_FIELD])
        ):
            index = _method_index(fields)
            if index >= 0 and fields[index].lower() in _WEAK_METHODS:
                out.append(_replace_field(code, index, "scram-sha-256") + comment)
                changed = True
                continue
        out.append(line)
    if not changed:
        return text, False
    result = "\n".join([PG_HBA_MARKER] + out)
    if text.endswith("\n"):
        result += "\n"
    return result, True


_SERVER_OPENER = re.compile(r"^server\b")


def _opens_server_block(line: str) -> bool:
    """True for a line that begins an nginx `server { ... }` block.

    Matched on a word boundary rather than on `server` and `{` sharing a
    line, because `server\\n{` and `server { # default` are both legal and
    both left RHEL's stock block in place -- and nginx then refuses to start
    with `duplicate default server`, which names neither file.

    A trailing `;` rules out `server 127.0.0.1:3000;`, which is a directive
    inside an `upstream` block and not a block opener at all.
    """
    stripped = line.strip()
    if not _SERVER_OPENER.match(stripped):
        return False
    remainder = stripped[len("server"):].strip()
    if remainder.endswith(";"):
        return False
    return remainder == "" or remainder.startswith("{")


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
        if _opens_server_block(lines[i]):
            depth = 0
            seen_brace = False
            j = i
            block = []
            while j < len(lines):
                depth += lines[j].count("{") - lines[j].count("}")
                if "{" in lines[j]:
                    seen_brace = True
                block.append(lines[j])
                j += 1
                # Only balanced once a brace has actually been seen: the
                # opener and its `{` are allowed to be on separate lines.
                if seen_brace and depth == 0:
                    break
            if seen_brace and depth == 0 and any("default_server" in b for b in block):
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


def _english_list(items: list) -> str:
    """`a`, `a and b`, `a, b and c` -- for a summary line a human reads."""
    items = list(items)
    if len(items) < 2:
        return "".join(items)
    return "%s and %s" % (", ".join(items[:-1]), items[-1])


def render_findings(findings: list, groups: list = None) -> str:
    """Render the report. `groups` names the filter the run was narrowed to.

    The clean summary has to say which groups it is speaking for. `doctor
    --disk` against a box with a SELinux failure printing "All checks passed."
    asserts something about the whole box that the run never established, and
    an operator who reads it believes they ran a full check.
    """
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
    scope = _english_list(groups or [])
    passed = "All %s checks passed." % scope if scope else "All checks passed."
    lines.append([passed, "Warnings above.", "Failures above."][worst])
    return "\n".join(lines) + "\n"


Step = collections.namedtuple("Step", "name command")


def render_plan(steps: list) -> str:
    """Number the steps and show each command, for `--dry-run` and for humans."""
    lines = []
    for i, step in enumerate(steps, 1):
        lines.append("%d. %s" % (i, step.name))
        for line in step.command.splitlines():
            lines.append("     %s" % line)
    return "\n".join(lines) + ("\n" if lines else "")


def is_ancestor_of(candidate: str, path: str) -> bool:
    """True when `candidate` is `path` or a directory containing it.

    copy_dir mirrors a directory by removing its destination first, so a
    destination of /opt/dsr destroys /opt/dsr/uploads without the string
    "uploads" appearing anywhere in it. Comparing prefixes textually rather
    than resolving the paths on disk is deliberate: this has to answer the
    same way on a machine where neither path exists.

    "" answers True for the same reason "/" does -- `"".rstrip("/") + "/"`
    prefixes every absolute path. An empty destination is not a path this
    tool should be mirroring onto either, and the safe answer to a question
    about deletion is the one that refuses.
    """
    candidate = (candidate or "").rstrip("/")
    return path == candidate or path.startswith(candidate + "/")


class LocalTarget:
    """Runs a step, or puts a file in place, on this machine.

    This tool runs on the server, as root, from the checkout that is already
    there. What used to travel over ssh is now a subprocess and a file copy,
    which is why every caller below takes one of these rather than reaching
    for subprocess itself: `run`, `write`, `copy_file` and `copy_dir` are
    the whole surface, and a test can substitute an object with the same
    four methods and assert on what a run would have done.

    Bash by name, not `shell=True`. /bin/sh is bash on RHEL 9 today, but the
    steps use `${x//a/b}`, `{ssh,http,https}` and `set -o pipefail`, and a
    box where /bin/sh became dash would fail them one at a time in ways that
    read like the step, not like the shell.
    """

    SHELL = "/bin/bash"

    def argv(self, command: str) -> list:
        return [self.SHELL, "-c", command]

    def run(self, command: str, check: bool = True):
        result = subprocess.run(self.argv(command), capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(
                "command failed (exit %d): %s\n%s"
                % (result.returncode, command, result.stderr)
            )
        return result

    def write(self, path: str, text: str, mode: str = "") -> None:
        """Write text to a path, creating the parent directory.

        With `mode`, the file is created with those permissions rather than
        chmod'ed into them afterwards: REMOTE_SECRETS holds both role
        passwords, and a file that is 0644 for the instant between creation
        and chmod is a file another user can open in that instant.
        """
        destination = pathlib.Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not mode:
            destination.write_text(text)
            return
        bits = int(mode, 8)
        handle = os.open(
            str(destination), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, bits
        )
        with os.fdopen(handle, "w") as stream:
            stream.write(text)
        # O_CREAT's mode applies only when the file did not already exist,
        # so a pre-existing 0644 file needs saying again.
        os.chmod(str(destination), bits)

    def copy_file(self, local: str, remote: str) -> None:
        source = pathlib.Path(local)
        if not source.is_file():
            raise Refusal("FATAL: %s is missing; nothing to copy to %s." % (local, remote))
        destination = pathlib.Path(remote)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source), str(destination))

    def copy_dir(self, local: str, remote: str) -> None:
        """Mirror a directory: the destination ends up holding exactly what
        the source holds, which means removing what was there first.

        That removal is why this refuses a destination that is, or contains,
        the uploads directory. Those are identity documents held as
        regulatory records; deploy_payload has never named such a path and a
        test walks it, but the check belongs where the deletion happens too.
        """
        if is_ancestor_of(remote, UPLOADS_DIR):
            raise Refusal(
                "FATAL: refusing to mirror %s onto %s -- that is %s or a "
                "directory containing it, and mirroring removes the "
                "destination first. Those are uploaded identity documents "
                "held as regulatory records." % (local, remote, UPLOADS_DIR)
            )
        source = pathlib.Path(local)
        if not source.is_dir():
            raise Refusal(
                "FATAL: %s does not exist, so there is nothing to install at "
                "%s. Run without --skip-build to build it." % (local, remote)
            )
        destination = pathlib.Path(remote)
        if destination.exists():
            shutil.rmtree(str(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(source), str(destination))


def _cat_heredoc_command(
    remote_path: str, content: str, marker: str = "DSR_EOF", expand: bool = False
) -> str:
    """A `cat > remote_path <<MARKER` fragment carrying file content.

    The delimiter is quoted by default, so the shell expands nothing inside
    and the content lands byte-for-byte, which is what lets a config file
    holding `$` and backticks travel inside a step at all.

    `expand=True` unquotes it, which is how the service .env is written:
    the body holds `${DB_PASS}` rather than the password itself, and the
    shell substitutes values it read from REMOTE_SECRETS. That is
    what keeps a secret out of every Step, and so out of `--dry-run`.
    """
    if not content.endswith("\n"):
        content += "\n"
    opener = marker if expand else "'%s'" % marker
    return "cat > %s <<%s\n%s%s" % (remote_path, opener, content, marker)


def shipped_text(path) -> str:
    """Read a file this tool ships beside itself and pushes to the box.

    deploy_steps embeds the unit file and nginx.conf in its commands, so
    even `--dry-run` reads them from disk. A missing one raised
    FileNotFoundError straight out of main, which showed a traceback to an
    operator who had only asked what would happen. An incomplete checkout is
    a refusal like any other, and it says which file.
    """
    try:
        return pathlib.Path(path).read_text()
    except OSError as exc:
        raise Refusal(
            "FATAL: %s is missing from this checkout (%s).\n"
            "       It ships beside the deployer and is written to the box\n"
            "       verbatim, so there is nothing to deploy without it."
            % (path, exc.strerror or exc)
        )


def atomic_write(path: str, text: str) -> None:
    """Replace a file's contents without ever leaving it truncated.

    `pathlib.Path.write_text` opens with O_TRUNC: from that instant until the
    write completes the file is empty on disk. If the process dies in that
    window -- a power cut, an OOM kill on a 1-vCPU box -- the
    file stays empty. For `pg_hba.conf` that means a host whose only
    authentication file has been destroyed, and every database connection
    the portal makes fails from then on.

    Writing a sibling temporary file and calling `os.replace` removes the
    window rather than making it recoverable: `os.replace` is atomic on
    POSIX, so a reader sees either the whole old file or the whole new one,
    and an interruption leaves the original wholly intact.

    Mode and ownership are copied from the original first. `os.replace`
    swaps inodes, and a `pg_hba.conf` that arrives owned by root instead of
    postgres is a second outage in place of the first.
    """
    target = pathlib.Path(path)
    try:
        original = os.stat(str(target))
    except OSError:
        original = None

    handle_fd, temp_path = tempfile.mkstemp(
        dir=str(target.parent), prefix=target.name + ".", suffix=".dsrtmp"
    )
    try:
        with os.fdopen(handle_fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if original is not None:
            os.chmod(temp_path, stat.S_IMODE(original.st_mode))
            if hasattr(os, "chown"):
                try:
                    os.chown(temp_path, original.st_uid, original.st_gid)
                except OSError:
                    # Not root, or a filesystem without ownership. The mode
                    # is already right; refusing the whole write over this
                    # would be worse than proceeding.
                    pass
        os.replace(temp_path, str(target))
    except BaseException:
        # The rename never happened, so the original is untouched. Take the
        # half-written temporary file with us rather than leaving litter
        # next to a config file an operator will later read.
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _source_secrets() -> str:
    """Prelude that brings REMOTE_SECRETS into a step's environment.

    `set -e` first, so a missing or unreadable secrets file stops the step
    instead of letting `${DB_PASS:?}` decide the outcome three lines later,
    and left on: both steps that source this are multi-line ones whose own
    statements must not mask each other either.
    """
    return "set -e\nset -a\n. %s\nset +a\n" % REMOTE_SECRETS


def _backup_once(path: str) -> str:
    """`cp` a file to `<path>.orig`, but only the first time.

    The spec promises a `.orig` of `pg_hba.conf` and of `nginx.conf` -- the
    copy an operator diffs against when they want to know what this tool
    changed, and restores from when they want it undone.

    Conditional, because provisioning is meant to be re-run. An
    unconditional `cp` on the second run would overwrite the true original
    with the already-rewritten copy, and the backup would then be a record
    of nothing.

    `cp -p` so the copy carries the original's mode, ownership and
    timestamps: a `pg_hba.conf.orig` that is world-readable when the file it
    came from was not would be a small leak of the same kind the rest of
    this file exists to prevent.
    """
    return "test -f %s.orig || cp -p %s %s.orig" % (path, path, path)


def _remote_text_fix(path: str, func_name: str) -> str:
    """Apply one of Task 4's pure text transforms to a file already on the box.

    Runs the copy of this tool already at REMOTE_SELF, so the same
    idempotent, comment-aware guard exercised by the unit tests decides
    whether anything changes -- never a shell sed re-deriving that logic on
    the box, where a wrong regex leaves an unbalanced config file.

    The write goes through atomic_write, not p.write_text: see that
    function for what truncation costs on a file postgres will not start
    without.
    """
    remote_dir = REMOTE_SELF.rsplit("/", 1)[0]
    return (
        "python3 -c \""
        "import sys; sys.path.insert(0, '%s'); import dsr_deploy as d, pathlib; "
        "p = pathlib.Path('%s'); t = p.read_text(); "
        "new, changed = d.%s(t); "
        "d.atomic_write('%s', new) if changed else None\""
    ) % (remote_dir, path, func_name, path)


# The two version assertions the install steps make about themselves.
#
# Each is used twice in its step: once as the "already good enough, skip the
# install" guard, and once `&&`-chained onto the end so the step's own exit
# code carries the claim its name makes. Before this only the first use
# existed, which meant the check ran *before* the install and never after.
#
# `node -v` prints `v22.11.0`; stripping the `v` and taking the first
# dot-field is version-length-proof in a way `cut -c2-3` was not -- that
# read "22" out of v22 and "9." out of v9, which compares as an error.
NODE_MAJOR_TEST = (
    '[ "$(node -v 2>/dev/null | tr -d v | cut -d. -f1)" -ge 22 ] 2>/dev/null'
)

# `postgres --version` prints `postgres (PostgreSQL) 16.4`. Asking the
# binary rather than rpm, because rpm answers about the package name and
# `postgresql-server` is the same package name on every stream: RHEL 9's
# default is PostgreSQL 13, and `rpm -q postgresql-server` is true of it.
#
# The floor is 13, not 16, and 16 is only what a bare host gets installed.
# The schema needs exactly two things a 12 could not give it: gen_random_uuid()
# built in rather than via pgcrypto (13), and `AS RESTRICTIVE` policies (10).
# Nothing in server/drizzle uses MERGE, multiranges, NULLS NOT DISTINCT or any
# other 14/15/16 feature -- checked. So a host already running 13 or 15 for
# something else is a host DSR can share, and refusing it would mean demanding
# a pg_upgrade of a cluster that works.
PG_MAJOR_TEST = (
    '[ "$(/usr/bin/postgres --version 2>/dev/null | '
    "awk '{print $NF}' | cut -d. -f1)\" -ge 13 ] 2>/dev/null"
)

# What every later step and every deploy assumes is already there.
#
# `tar` is on this list because deploy/backup.sh runs `tar -czf` over
# /opt/dsr/uploads and the database dump on a timer, and a RHEL 9 minimal
# install does not reliably ship it. Without it provisioning succeeds,
# reports success, and the first backup is the one that fails -- which
# nobody is watching. It is one package and it is load bearing; do not
# trim it.
BASE_PACKAGES = (
    "curl",
    "ca-certificates",
    # `semanage`, which doctor's SELinux advice assumes exists.
    "policycoreutils-python-utils",
    "firewalld",
    "nginx",
    "tar",
)


Listener = collections.namedtuple("Listener", "port process pid")

# `ss -lntp` prints, per socket:
#   LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1234,fd=6))
# The local address column is the fourth field and the port is whatever
# follows the last colon, which is the only form that survives IPv6
# (`[::]:80`) and a bound address (`127.0.0.1:3000`) alike.
_SS_PROCESS = re.compile(r'users:\(\("([^"]+)",pid=(\d+)')

# Everything DSR itself puts on a port, plus 22. A report that told an
# operator to stop sshd would be a report that bricks the box.
DSR_OWNED_PORTS = (22, 80, 443, APP_PORT, 5432)

LISTENERS_COMMAND = "ss -lntp 2>&1"

# pid -> unit, asked of systemd rather than guessed from the process name.
# `ss` says "python3"; systemd says "data-formulator.service", and only the
# second one can be handed back to the operator as a command to run.
PID_UNITS_COMMAND = (
    "for pid in $(ss -lntpH 2>/dev/null | grep -o 'pid=[0-9]*' | "
    "cut -d= -f2 | sort -u); do "
    "unit=$(systemctl status \"$pid\" 2>/dev/null | head -1 | awk '{print $2}'); "
    "echo \"$pid ${unit:-unknown}\"; done"
)


def parse_listeners(text: str) -> list:
    """Every TCP listener `ss -lntp` reported. [] for anything unreadable."""
    found = []
    for line in (text or "").splitlines():
        fields = line.split()
        if len(fields) < 5 or not line.strip().startswith("LISTEN"):
            continue
        local = fields[3]
        _host, _sep, port = local.rpartition(":")
        if not port.isdigit():
            continue
        match = _SS_PROCESS.search(line)
        process = match.group(1) if match else "unknown"
        pid = match.group(2) if match else ""
        found.append(Listener(int(port), process, pid))
    return found


def parse_pid_units(text: str) -> dict:
    """`<pid> <unit>` lines into a mapping. Unreadable lines are skipped."""
    units = {}
    for line in (text or "").splitlines():
        fields = line.split()
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        if fields[1] in ("unknown", "-"):
            continue
        units[fields[0]] = fields[1]
    return units


def takeover_report(listeners: list, pid_units: dict, owned=DSR_OWNED_PORTS) -> str:
    """What else is listening, and the exact command that turns each one off.

    "" when nothing else is. This tool does not stop them itself, and that
    is a deliberate line rather than an omission: moving a config file aside
    is reversible in one command, but stopping a daemon on a box nobody has
    inventoried can take down someone else's production with nothing left on
    screen to say what it was. Printing the command costs the operator one
    paste and leaves the decision with the person who knows the box.
    """
    others = sorted(
        set(l for l in listeners if l.port not in owned), key=lambda l: l.port
    )
    if not others:
        return ""
    lines = [
        "Other services are listening on this box. This tool does not stop",
        "them: moving a config file aside is reversible in one command,",
        "stopping an unidentified daemon is not. Each one, and the command",
        "that turns it off for good:",
        "",
    ]
    for listener in others:
        unit = pid_units.get(listener.pid, "")
        lines.append(
            "  port %-6d %s (pid %s)"
            % (listener.port, listener.process, listener.pid or "?")
        )
        if unit:
            lines.append(
                "      systemctl stop %s && systemctl disable %s" % (unit, unit)
            )
        elif listener.pid:
            lines.append(
                "      identify it first:  systemctl status %s" % listener.pid
            )
        else:
            lines.append(
                "      identify it first:  ss -lntp | grep ':%d '" % listener.port
            )
    lines.append("")
    lines.append(
        "Port 22 is left alone deliberately: it is how you get back in."
    )
    return "\n".join(lines) + "\n"


def provision_steps() -> list:
    """The RHEL 9 provisioning sequence, in order.

    Each command is a shell fragment executed on the box, and every one is
    safe to run twice: `dnf install -y` is already idempotent, directory
    creation uses `mkdir -p` / `install -d`, `setsebool -P` is idempotent,
    and the two file rewrites go through Task 4's guarded, no-op-on-replay
    functions rather than an unconditional sed.

    Commands within a step are joined with `&&`, not `;`. `A; B` reports
    B's exit code: if A truncated a config file and then died, a `systemctl
    reload` that succeeds afterwards makes the whole step look fine. The
    three places a `;` survives are marked, and in each of them the earlier
    command is one whose failure is the expected case.
    """
    return [
        Step(
            "preflight: confirm RHEL 9 and disk headroom",
            # Deliberate `;`: this step reports, it does not gate. The grep
            # branch warns rather than aborting -- CentOS Stream and Alma
            # are fine targets -- and df must print either way.
            "grep -q 'platform:el9' /etc/os-release "
            "&& echo 'RHEL 9 detected' || echo 'WARNING: does not look like RHEL 9'; "
            "df -h / /var",
        ),
        Step(
            "install base packages",
            "dnf install -y %s && dnf clean all" % " ".join(BASE_PACKAGES),
        ),
        Step(
            "install Node.js 22",
            # Deliberate `;` after `module reset`: it exits non-zero when no
            # nodejs stream is enabled, which is the common case on a bare
            # box and not a reason to skip the install that follows.
            #
            # The `-ge 22` test on the first line is the *skip* guard, read
            # before anything is installed. The runbook says provisioning
            # "asserts node -v reports major >= 22", and nothing re-read it
            # afterwards -- so a stream that enabled and installed something
            # older reported success. The trailing test is that assertion:
            # `&&`-chained, so the step's own exit code carries it.
            "((command -v node >/dev/null 2>&1 && %s) || "
            "(dnf module reset -y nodejs >/dev/null 2>&1; "
            "dnf module enable -y nodejs:22 && dnf install -y nodejs && "
            "dnf clean all)) && %s"
            % (NODE_MAJOR_TEST, NODE_MAJOR_TEST),
        ),
        Step(
            "install PostgreSQL (16 on a bare host, 13+ accepted)",
            # Deliberate `;` after `module reset`, for the same reason as
            # the Node step above.
            #
            # The guard was `rpm -q postgresql-server`, which is true of any
            # version. RHEL 9's default stream is PostgreSQL 13, so on a host
            # where someone had already run `dnf install postgresql-server`
            # this step short-circuited, reported success under the name
            # "install PostgreSQL 16", and left 13 running -- and the next
            # thing to notice would have been a migration failing on syntax
            # that 13 does not have. The guard now asks the version, and the
            # trailing test asserts it afterwards either way.
            #
            # A box that already has PostgreSQL and is not on 16 is a
            # refusal, not an upgrade. `dnf module reset` followed by
            # `enable postgresql:16` on a host with a live 13 cluster
            # replaces the binaries under a data directory initdb'd by the
            # older major, and PostgreSQL will not start on it -- which
            # takes out whatever else on this box was using that cluster,
            # not only DSR. Migrating a cluster across a major version is
            # pg_upgrade's job and a decision for whoever owns the data.
            "( if rpm -q postgresql-server >/dev/null 2>&1; then\n"
            "    %s || { echo 'FATAL: PostgreSQL is already installed on this "
            "host and it is not 16.' >&2;\n"
            "            echo '       Upgrading in place would leave the "
            "existing cluster unable to start,' >&2;\n"
            "            echo '       and anything else using it down with "
            "it. Migrate it with pg_upgrade' >&2;\n"
            "            echo '       first, or deploy DSR to a host of its "
            "own.' >&2; exit 1; };\n"
            "  else\n"
            "    dnf module reset -y postgresql >/dev/null 2>&1;\n"
            "    dnf module enable -y postgresql:16 && "
            "dnf install -y postgresql-server postgresql-contrib && "
            "dnf clean all;\n"
            "  fi ) && %s"
            % (PG_MAJOR_TEST, PG_MAJOR_TEST),
        ),
        Step(
            "initialize the data directory (postgresql-setup --initdb)",
            # `&&`, not `;`: an initdb that fails leaves an empty data
            # directory, and `systemctl enable --now postgresql` would then
            # be the command whose exit code the step reports.
            "( test -f /var/lib/pgsql/data/PG_VERSION || postgresql-setup --initdb ) "
            "&& systemctl enable --now postgresql",
        ),
        Step(
            "pg_hba: require scram-sha-256 on loopback (Task 4's rewrite_pg_hba)",
            # `&&` is load-bearing here above everywhere else. With `;`, a
            # rewrite that died mid-write left pg_hba.conf empty, `reload`
            # succeeded, and the step reported success on a box that could
            # no longer authenticate anything. atomic_write removes the
            # truncation; `&&` removes the silence.
            _backup_once(PG_HBA_REMOTE)
            + " && "
            + _remote_text_fix(PG_HBA_REMOTE, "rewrite_pg_hba")
            + " && systemctl reload postgresql",
        ),
        Step(
            "create the dsr and dsr_app roles and database",
            # DB_PASS and APP_PASS come from REMOTE_SECRETS, a 0600 file
            # pushed over stdin, so no password is ever an argv element on
            # the box or a character of this Step.
            #
            # `set -e` rather than `&&` between these: a heredoc terminator
            # cannot be followed by `&&` without hiding the operator that
            # matters at the end of the line above it. `set -e` gives the
            # same guarantee -- the first failure stops the step -- across
            # all four statements.
            _source_secrets()
            # shell_quote protects the shell layer; nothing protected the
            # SQL layer. An apostrophe in DB_PASS closed the string literal,
            # psql failed, and psql echoes the offending statement back in
            # its `LINE n:` context -- which step_failure_message then
            # prints verbatim, password and all. Doubling the quote is the
            # SQL escape, done once here rather than four times below.
            + "DB_PASS_SQL=${DB_PASS:?DB_PASS required}\n"
            "DB_PASS_SQL=${DB_PASS_SQL//\\'/\\'\\'}\n"
            "APP_PASS_SQL=${APP_PASS:?APP_PASS required}\n"
            "APP_PASS_SQL=${APP_PASS_SQL//\\'/\\'\\'}\n"
            + "cd / && sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL\n"
            "DO \\$\\$\n"
            "BEGIN\n"
            "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr') THEN\n"
            "    CREATE ROLE dsr LOGIN PASSWORD '${DB_PASS_SQL}';\n"
            "  ELSE\n"
            "    ALTER ROLE dsr PASSWORD '${DB_PASS_SQL}';\n"
            "  END IF;\n"
            "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr_app') THEN\n"
            "    CREATE ROLE dsr_app LOGIN PASSWORD '${APP_PASS_SQL}';\n"
            "  ELSE\n"
            "    ALTER ROLE dsr_app PASSWORD '${APP_PASS_SQL}';\n"
            "  END IF;\n"
            "END\n"
            "\\$\\$;\n"
            "SQL\n"
            "cd / && sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'dsr'\" "
            "| grep -q 1 || sudo -u postgres createdb -O dsr -E UTF8 -T template0 dsr\n"
            "cd / && sudo -u postgres psql -d dsr -v ON_ERROR_STOP=1 "
            "-c \"GRANT ALL ON SCHEMA public TO dsr; ALTER SCHEMA public OWNER TO dsr;\"",
        ),
        Step(
            "create the dsr service user and directories",
            # `&&` throughout: with `;`, a useradd that failed left every
            # chown running against a user that does not exist, and the last
            # chown's exit code was all the operator saw.
            "( id -u dsr >/dev/null 2>&1 || "
            "useradd --system --no-create-home --home-dir %s --shell /sbin/nologin dsr ) "
            "&& mkdir -p %s/server %s/public-form %s/admin "
            "&& install -d -o dsr -g dsr -m 750 %s "
            "&& chown -R dsr:dsr %s "
            "&& chown -R nginx:nginx %s"
            % (
                INSTALL_PREFIX,
                INSTALL_PREFIX,
                WEB_ROOT,
                WEB_ROOT,
                UPLOADS_DIR,
                INSTALL_PREFIX,
                WEB_ROOT,
            ),
        ),
        Step(
            "SELinux: allow nginx to proxy to the app (httpd_can_network_connect)",
            "setsebool -P httpd_can_network_connect on",
        ),
        Step(
            "nginx: remove RHEL's stock default_server (Task 4's neutralise_default_server)",
            _backup_once(NGINX_MAIN_CONF_REMOTE)
            + " && "
            + _remote_text_fix(NGINX_MAIN_CONF_REMOTE, "neutralise_default_server")
            # `nginx -t` before the service is started, not after: the step
            # above just edited nginx.conf, and starting nginx on a config
            # it will not parse reports a systemd failure that names the
            # unit rather than the line. deploy_steps already orders it this
            # way.
            + " && nginx -t && systemctl enable --now nginx",
        ),
        Step(
            "firewalld: open ssh, http, https",
            "systemctl enable --now firewalld && "
            "firewall-cmd --permanent --add-service={ssh,http,https} && "
            "firewall-cmd --reload",
        ),
        Step(
            "journald: cap disk usage at 200M",
            "mkdir -p /etc/systemd/journald.conf.d && "
            "printf '[Journal]\\nSystemMaxUse=200M\\n' "
            "> /etc/systemd/journald.conf.d/dsr.conf && "
            "systemctl restart systemd-journald",
        ),
        Step(
            "zram: swap-on-compressed-RAM instead of a swapfile",
            # `&&`: writing the config after a failed install, or starting
            # the unit after a config that never landed, both end with a
            # step that exits 0 and a box with no swap at all.
            "dnf install -y zram-generator && dnf clean all "
            "&& printf '[zram0]\\nzram-size = min(ram / 2, 2048)\\n' "
            "> /etc/systemd/zram-generator.conf "
            "&& systemctl daemon-reload "
            "&& systemctl start systemd-zram-setup@zram0.service",
        ),
    ]


def _env_file_content() -> str:
    """The service .env, in the same shape deploy.sh writes -- see its
    comments on why EMAIL_PROVIDER and COOKIE_SECURE live here rather than
    in app_settings.

    Every value is a shell reference, not a value. The remote shell expands
    them from REMOTE_SECRETS through an unquoted heredoc, exactly as
    deploy.sh's `<<ENV` does. That is deliberate: it means no Step ever
    contains a password, so `--dry-run` can print the entire plan and
    nothing sensitive is on the screen or in the box's process table.

    The `:-` defaults are deploy.sh's, and they matter: `${COOKIE_SECURE:-true}`
    treats an empty value as unset, so a secrets file that omits the key
    still produces a Secure cookie rather than an empty setting.
    """
    lines = [
        "NODE_ENV=production",
        "PORT=%d" % APP_PORT,
        "DATABASE_URL=postgres://dsr:${DB_PASS}@127.0.0.1:5432/dsr",
        "DATABASE_URL_APP=postgres://dsr_app:${APP_PASS}@127.0.0.1:5432/dsr",
        "CRYPTO_MASTER_KEY=${CRYPTO_MASTER_KEY}",
        "COOKIE_SECURE=${COOKIE_SECURE:-true}",
        "EMAIL_PROVIDER=${EMAIL_PROVIDER:-graph}",
        "PRIVACY_MAILBOX=${PRIVACY_MAILBOX:-}",
        "GRAPH_TENANT_ID=${GRAPH_TENANT_ID:-}",
        "GRAPH_CLIENT_ID=${GRAPH_CLIENT_ID:-}",
        "GRAPH_CLIENT_SECRET=${GRAPH_CLIENT_SECRET:-}",
    ]
    return "\n".join(lines) + "\n"


# Re-applies a Let's Encrypt certificate onto the freshly-pushed, HTTP-only
# nginx conf, and skips cleanly when no certificate has been issued yet.
# CERT_NAME is discovered on the box, inside this fragment, at run time --
# not by the operator's machine beforehand -- so this one Step stays static
# while still doing nothing on a box with no domain pointed at it yet.
#
# `set -e` so a sed that failed cannot be masked by the certbot line that
# follows it -- the outcome there is an nginx config still saying
# `server_name _;` while the step reports success. The CERT_NAME assignment
# is safe under `set -e`: it is a pipeline ending in `head`, which exits 0
# even when `ls` found no directory.
_TLS_REAPPLY_COMMAND = (
    "set -e\n"
    "CERT_NAME=$(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | head -1)\n"
    "if [ -n \"$CERT_NAME\" ]; then\n"
    "  sed -i \"s/server_name _;/server_name $CERT_NAME;/\" %s\n"
    "  certbot install --nginx --cert-name \"$CERT_NAME\" --redirect --non-interactive "
    ">/dev/null 2>&1\n"
    "fi"
) % NGINX_SITE_CONF_REMOTE

# Restores PUBLIC_BASE_URL / INTERNAL_BASE_URL in app_settings from the
# certificate's hostname, but only when a row is missing or empty -- an
# unconditional overwrite would clobber an operator's deliberate override.
# Without these, the mailer falls back to a loopback address and every link
# it sends is dead.
_ENSURE_URLS_JS = """const pg = require('pg');
(async () => {
  const host = process.argv[2];
  const c = new pg.Client(process.env.DATABASE_URL);
  await c.connect();
  const rows = [
    ['PUBLIC_BASE_URL', `https://${host}`],
    ['INTERNAL_BASE_URL', `https://${host}/admin`],
  ];
  for (const [key, value] of rows) {
    const existing = await c.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    if (!existing.rows[0] || !existing.rows[0].value) {
      await c.query(
        'INSERT INTO app_settings (key, value, secret) VALUES ($1, $2, false) ' +
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
      console.log(`   restored ${key} = ${value}`);
    }
  }
  await c.end();
})();
"""

# Every reference to `$1`/argv here is inside a *single* argv element handed
# straight to bash -c -- never spliced into another shell string first. That
# nested-quoting bug is exactly how this broke once in deploy.sh.
#
# The heredoc body and its closing delimiter are left flush against the left
# margin, not indented under the `if`, because `<<'NODE'` (unlike `<<-`) only
# recognises the terminator when it starts in column one -- an indented
# "  NODE" would not match, and the shell would read past `fi` looking for it.
#
# `set -e` again: the heredoc that writes ensure-urls.cjs is joined to the
# `node` invocation by a newline, so without it a failed write is reported
# as a successful step.
_ENSURE_URLS_COMMAND = (
    "set -e\n"
    "CERT_NAME=$(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | head -1)\n"
    "if [ -n \"$CERT_NAME\" ]; then\n"
    + _cat_heredoc_command("%s/server/ensure-urls.cjs" % INSTALL_PREFIX, _ENSURE_URLS_JS, "NODE")
    + "\n"
    "  cd %s/server && set -a && . ./.env && set +a && "
    "node ensure-urls.cjs \"$CERT_NAME\" && rm -f ensure-urls.cjs\n"
    "fi"
) % INSTALL_PREFIX


# Move every other site in conf.d aside, into a timestamped directory, and
# say where they went.
#
# DSR's conf declares `listen 80 default_server`, and nginx refuses to start
# with two of those -- so on a box already serving something else, one of the
# two sites is going to lose port 80 whatever happens. Moving the other one
# aside is the version of that with a way back: `mv` is reversible in one
# command, printed at the end of the step and again in the log, and the
# directory is stamped so two runs cannot overwrite each other's rescue copy.
#
# `if`, not `[ ... ] && continue`: under `set -e` a false test as the last
# command of a loop body ends the whole step, which would leave half the
# sites moved and no message saying so.
_DISPLACE_NGINX_SITES_COMMAND = (
    "set -e\n"
    "mkdir -p %s\n"
    "DISABLED=/etc/nginx/conf.d.disabled-$(date +%%Y%%m%%d-%%H%%M%%S)\n"
    "MOVED=0\n"
    "for CONF in /etc/nginx/conf.d/*.conf; do\n"
    "  test -e \"$CONF\" || continue\n"
    "  if [ \"$CONF\" != %s ]; then\n"
    "    mkdir -p \"$DISABLED\"\n"
    "    mv \"$CONF\" \"$DISABLED\"/\n"
    "    echo \"displaced $CONF -> $DISABLED/\"\n"
    "    MOVED=$((MOVED + 1))\n"
    "  fi\n"
    "done\n"
    "if [ \"$MOVED\" -gt 0 ]; then\n"
    "  echo \"$DISABLED\" > %s\n"
    "  echo \"to put them back, in one command:\"\n"
    "  echo \"  mv $DISABLED/*.conf /etc/nginx/conf.d/ && nginx -t && "
    "systemctl reload nginx\"\n"
    "else\n"
    "  rm -f %s\n"
    "  echo 'no other nginx sites were in /etc/nginx/conf.d'\n"
    "fi"
) % (
    STATE_PATH.rsplit("/", 1)[0],
    NGINX_SITE_CONF_REMOTE,
    DISPLACED_MARKER,
    DISPLACED_MARKER,
)


def _nginx_rollback_command() -> str:
    """Put back what was here, then reload, then fail the step.

    Reached only when `nginx -t` rejects the config this step just wrote. The
    box was serving something a moment ago -- possibly someone else's site --
    and the worst outcome is not a failed deployment but a box left serving
    nothing because a file this tool wrote will not parse. So the previous
    dsr.conf goes back, the displaced sites come back, and nginx is reloaded
    onto the configuration it had before this step ran.
    """
    return (
        "  echo 'FATAL: nginx rejected the DSR site; putting back what was "
        "here' >&2\n"
        "  if [ -f %s.prev ]; then\n"
        "    cp -p %s.prev %s\n"
        "  else\n"
        "    rm -f %s\n"
        "  fi\n"
        "  DISABLED=$(cat %s 2>/dev/null || true)\n"
        "  if [ -n \"$DISABLED\" ] && [ -d \"$DISABLED\" ]; then\n"
        "    mv \"$DISABLED\"/*.conf /etc/nginx/conf.d/ || true\n"
        "    echo \"restored the displaced sites from $DISABLED\" >&2\n"
        "  fi\n"
        "  nginx -t && systemctl reload nginx || true\n"
        "  exit 1\n"
    ) % (
        NGINX_SITE_CONF_REMOTE,
        NGINX_SITE_CONF_REMOTE,
        NGINX_SITE_CONF_REMOTE,
        NGINX_SITE_CONF_REMOTE,
        DISPLACED_MARKER,
    )


def _install_site_command() -> str:
    """Write the unit and the site config, then prove nginx will take it.

    `.orig` is the copy an operator diffs against, taken once and never
    overwritten. `.prev` is this run's undo, taken every time -- they are
    different jobs and one file cannot do both.
    """
    conf = NGINX_SITE_CONF_REMOTE
    return (
        "set -e\n"
        # `.orig` only on the first run, and only if there is anything to copy.
        "if [ ! -f %s.orig ] && [ -f %s ]; then cp -p %s %s.orig; fi\n"
        "if [ -f %s ]; then cp -p %s %s.prev; else rm -f %s.prev; fi\n"
        % (conf, conf, conf, conf, conf, conf, conf, conf)
        + _cat_heredoc_command(UNIT_REMOTE, shipped_text(UNIT_FILE_LOCAL), "DSR_UNIT_EOF")
        + "\n"
        + _cat_heredoc_command(conf, shipped_text(NGINX_CONF_LOCAL), "DSR_NGINX_EOF")
        + "\n"
        "if ! nginx -t; then\n"
        + _nginx_rollback_command()
        + "fi"
    )


def deploy_steps(env: dict) -> list:
    """The deployment sequence, in order.

    Putting the compiled bundles in place is LocalTarget's job (copy_file
    and copy_dir move bytes; they are not steps here). This is everything
    that happens once those bytes are where they belong.
    Migration must precede the restart -- an old process serving a schema
    it does not understand is worse than a few extra seconds of downtime.

    `env` is accepted because callers hold the parsed secrets by the time
    they get here, and deliberately not read: no secret value belongs in a
    Step, because a Step is what `--dry-run` prints. The values reach the
    box in REMOTE_SECRETS instead, and the steps that need them source it.
    A test pins that -- pass a password in and it must not appear in any
    command.
    """
    return [
        Step(
            "write /opt/dsr/server/.env (keep .env.bak first)",
            # `set -e`: without it, a heredoc that ran out of disk halfway
            # left a truncated .env, `chmod 600` succeeded, and the step
            # reported success on a service that will not start.
            _source_secrets()
            + ("test -f %s && cp %s %s.bak || true\n" % (ENV_PATH, ENV_PATH, ENV_PATH))
            + _cat_heredoc_command(ENV_PATH, _env_file_content(), "ENV", expand=True)
            + ("\nchmod 600 %s" % ENV_PATH),
        ),
        Step(
            "npm ci --omit=dev",
            "cd %s/server && "
            "(npm ci --omit=dev --no-audit --no-fund || "
            "npm install --omit=dev --no-audit --no-fund)" % INSTALL_PREFIX,
        ),
        Step(
            "npm cache clean --force",
            "npm cache clean --force",
        ),
        Step(
            "run database migrations (node scripts/migrate.mjs)",
            "cd %s/server && set -a && . ./.env && set +a && node scripts/migrate.mjs"
            % INSTALL_PREFIX,
        ),
        Step(
            "import form schemas (node scripts/import-forms.mjs)",
            # `set -o pipefail` before the pipe: a pipeline reports the exit
            # code of its *last* command, so without it a failed import is
            # masked by a `tail -1` that succeeded on empty input.
            "cd %s/server && set -a && . ./.env && set +a && set -o pipefail && "
            "node scripts/import-forms.mjs | tail -1" % INSTALL_PREFIX,
        ),
        Step(
            "fix ownership and SELinux context (restorecon)",
            # `&&`: a restorecon that succeeds after a chown that failed is
            # a step that reports success over the wrong ownership, which is
            # a 403 on every page with nothing in the log naming the cause.
            "chown -R dsr:dsr %s && chown -R nginx:nginx %s "
            "&& mkdir -p %s && chown dsr:dsr %s && chmod 750 %s "
            "&& restorecon -R %s %s"
            % (
                INSTALL_PREFIX,
                WEB_ROOT,
                UPLOADS_DIR,
                UPLOADS_DIR,
                UPLOADS_DIR,
                INSTALL_PREFIX,
                WEB_ROOT,
            ),
        ),
        Step(
            "move any other nginx site aside (reversibly)",
            _DISPLACE_NGINX_SITES_COMMAND,
        ),
        Step(
            "install the dsr-api unit and nginx conf.d/dsr.conf",
            # `set -e`: two heredocs joined by a newline means the second
            # one's exit code is the step's, and a unit file that never
            # landed would be reported as installed.
            _install_site_command(),
        ),
        Step(
            "re-apply TLS certificate if one is already installed",
            _TLS_REAPPLY_COMMAND,
        ),
        Step(
            "ensure portal URLs are set (ensure-urls)",
            _ENSURE_URLS_COMMAND,
        ),
        Step(
            "validate nginx config (nginx -t)",
            "nginx -t",
        ),
        Step(
            "systemctl daemon-reload",
            "systemctl daemon-reload",
        ),
        Step(
            "restart dsr-api",
            # The tolerance of a failing `enable` is made explicit with
            # `|| true` rather than left implicit in a `;`. The restart is
            # the command whose exit code this step is about.
            "( systemctl enable --now %s >/dev/null 2>&1 || true ) "
            "&& systemctl restart %s" % (SERVICE, SERVICE),
        ),
        Step(
            "reload nginx",
            "systemctl reload nginx",
        ),
    ]


# ---------------------------------------------------------------------------
# provision and deploy: the decisions, separated from the side effects
#
# Everything below that carries a judgement -- what the disk budget is, which
# paths get pushed where, whether two fingerprints may differ, when the health
# poll gives up -- is a pure function with a test. The functions further down
# that shell out hold no logic beyond calling these in order, because a
# decision buried inside a function that runs commands is a decision nobody
# can test without a server.
# ---------------------------------------------------------------------------

# The one file the operator fills in. One host, one file: the ssh-era
# convention of a file per droplet went with the ssh transport, and this
# tool now only ever deploys to the box it is running on. SECRETS_FILE
# still overrides it, for a box that keeps it somewhere else.
DEFAULT_SECRETS_NAME = ".secrets.env"

# What deploy actually spends under the install prefix. Numbers from the
# spec's refusal example; the host has ~10 GB and is mostly full, so this
# refusal is a path an operator will really take.
#
# 1024-based, because human_bytes is: as `* 1000 * 1000` the breakdown an
# operator reads said "node_modules ~295.6 MiB" under a constant named 310,
# and a refusal that disagrees with its own source is a refusal nobody can
# check.
DEPLOY_NODE_MODULES_BYTES = 310 * 1024 * 1024
DEPLOY_DIST_BYTES = 40 * 1024 * 1024
DEPLOY_TRANSFER_HEADROOM_BYTES = 70 * 1024 * 1024
DEPLOY_BYTES = (
    DEPLOY_NODE_MODULES_BYTES + DEPLOY_DIST_BYTES + DEPLOY_TRANSFER_HEADROOM_BYTES
)

# Provisioning installs nginx, Node 22, PostgreSQL 16 and the SELinux tooling
# under /usr, and fills the dnf cache doing it -- which downloads to
# /var/cache/dnf, because the steps clean the cache afterwards rather than
# during. Two figures rather than one: charging the whole total to /usr is
# right only by accident on a single-root box, and wrong on a box with a
# separate /var, which is the layout to expect here. check_budget sums per
# mount, so a single-root box still sees the total.
#
# Estimates, and labelled as such: being roughly right before the fact beats
# being exactly right halfway through a failed `dnf install`.
#
# 1024-based, for the reason given over the deploy constants above: as
# `* 1000 * 1000` the refusal printed "572.2 MiB" under a constant named
# 600, and a refusal that disagrees with its own source is a refusal nobody
# can check.
PROVISION_INSTALL_BYTES = 600 * 1024 * 1024
PROVISION_CACHE_BYTES = 300 * 1024 * 1024
PROVISION_PACKAGE_BYTES = PROVISION_INSTALL_BYTES + PROVISION_CACHE_BYTES

# The keys each command stages on the box. Provisioning only ever needs the
# two role passwords; nothing else it does touches a secret.
PROVISION_SECRET_KEYS = ("DB_PASS", "APP_PASS")
DEPLOY_SECRET_KEYS = (
    "DB_PASS",
    "APP_PASS",
    "CRYPTO_MASTER_KEY",
    "COOKIE_SECURE",
    "EMAIL_PROVIDER",
    "PRIVACY_MAILBOX",
    "GRAPH_TENANT_ID",
    "GRAPH_CLIENT_ID",
    "GRAPH_CLIENT_SECRET",
)

# deploy.sh's numbers, and its reason, quoted because it is the whole
# justification for polling at all: "on a single-vCPU box Nest can take well
# over four seconds to bind, and a one-shot probe reports a false failure on a
# deploy that actually succeeded."
HEALTH_ATTEMPTS = 20
HEALTH_INTERVAL_SECONDS = 3

JOURNAL_TAIL_COMMAND = "journalctl -u %s -n 25 --no-pager" % SERVICE

PayloadItem = collections.namedtuple("PayloadItem", "kind local remote")

# Directories the operator builds before anything is pushed.
BUILD_DIRS = ("server", "apps/admin", "apps/public-form")


def shell_quote(value: str) -> str:
    """Single-quote a value for a shell, closing and reopening around quotes.

    A DB_PASS containing an apostrophe is not exotic, and unquoted it turns
    REMOTE_SECRETS into a syntax error at best and a truncated password at
    worst -- which would then be written into .env and into the role, and
    the portal would fail to authenticate with no clue why.
    """
    return "'" + str(value if value is not None else "").replace("'", "'\\''") + "'"


def remote_secrets_content(env: dict, keys) -> str:
    """The 0600 file staged at REMOTE_SECRETS: one quoted KEY=value per key.

    Absent keys are written empty rather than omitted, so `${X:-default}` in
    the .env body sees an empty value and applies its default, instead of
    the step dying on an unset variable.
    """
    return "".join("%s=%s\n" % (key, shell_quote(env.get(key, ""))) for key in keys)


# The characters that mean something to a URL parser between the `://` and
# the path. The .env writes `postgres://dsr:${DB_PASS}@127.0.0.1:5432/dsr`
# with no percent-encoding, so any of these inside a password is read as
# structure rather than as a character:
#
#   /  ends the netloc, so the rest of the password becomes the path
#   @  ends the userinfo, so the rest of the password becomes the host
#   :  starts the port, so the rest of the password has to be digits
#   ?  starts the query, #  starts the fragment
#   %  is read as an escape by the parser, not as itself
#
# `openssl rand -base64 32` -- what this file's own error messages
# recommend -- emits `/` and `+`, so this is not a hypothetical class of
# password. Run under bash with APP_PASS=pw/with/slash the real .env body
# expands to `postgres://dsr_app:pw/with/slash@127.0.0.1:5432/dsr`, which
# node-postgres reads as host `dsr_app` with no port at all.
#
# `%` fails silently rather than loudly, which is why it is not grouped with
# the six characters above it. This file's own copy of pg-connection-string
# (server/node_modules/pg-connection-string/index.js) calls
# decodeURIComponent on the password it parses out, so `abc%41def` becomes
# `abcAdef` with no error raised anywhere. Provisioning writes the *raw*
# string into postgres as the role's password -- the SQL layer never
# decodes anything -- so the two ends of the same deploy disagree on what
# the password is, the API cannot authenticate, and systemd crash-loops it,
# same as every other character in this set. The recommended generators
# below cannot produce a `%`, so this only ever bites a hand-chosen
# password -- which is exactly the kind likely to contain one.
URL_RESERVED_IN_PASSWORD = "/@:?#%"

# A generator that cannot emit any of the above. Both are 32 bytes of
# entropy; the second is the first with the offending base64 characters
# stripped, which shortens the string without weakening the source.
PASSWORD_GENERATOR_ADVICE = (
    "Generate one with `openssl rand -hex 32`, or "
    "`openssl rand -base64 32 | tr -d '/+='`."
)


def validate_role_passwords(env: dict) -> None:
    """Raise unless both database role passwords are there and URL-safe.

    An absent key is staged as `''` rather than omitted, and the .env body
    references a bare `${DB_PASS}` with no `:?`. So a secrets file missing
    either one produces `postgres://dsr:@127.0.0.1:5432/dsr`, the API fails
    to authenticate, systemd crash-loops it, and nothing upstream said a
    word. Provisioning happens to catch this -- its SQL uses `${DB_PASS:?}`
    -- but deploying did not, and deploying is the command that runs far
    more often.

    A password holding a URL-reserved character produces the *same* ending
    by a different route: the .env interpolates it raw, node-postgres parses
    the structure rather than the password, the API cannot authenticate and
    systemd crash-loops it. This function existed to stop exactly that
    outcome and only ever checked for emptiness, which is one of the two
    ways in.

    It is also the trigger for two other bugs -- doctor printing a password
    that contains a `/`, and the journal dump that follows the crash-loop it
    causes. Refusing here removes the trigger; both of those are fixed
    anyway, because a bug that has recurred three times is one to hold at
    more than one line.
    """
    missing = [key for key in ROLE_PASSWORD_KEYS if not (env.get(key) or "").strip()]
    if missing:
        raise SecretsError(
            "These database passwords are missing or empty in the secrets "
            "file: %s. The .env would carry an empty password, the API would "
            "fail to authenticate against postgres, and systemd would "
            "crash-loop it." % " ".join(missing)
        )
    for key in ROLE_PASSWORD_KEYS:
        value = (env.get(key) or "").strip()
        bad = [c for c in URL_RESERVED_IN_PASSWORD if c in value]
        if bad:
            raise SecretsError(
                "%s contains %s, which the connection string cannot carry. "
                "The .env writes postgres://user:${%s}@127.0.0.1:5432/dsr "
                "with no percent-encoding, so node-postgres reads that "
                "character as structure: the API would fail to authenticate "
                "and systemd would crash-loop it. %s"
                % (
                    key,
                    " and ".join("`%s`" % c for c in bad),
                    key,
                    PASSWORD_GENERATOR_ADVICE,
                )
            )


def validate_secrets(env: dict) -> list:
    """Both of deploy.sh's local guards, in its order. Returns warnings.

    Raises SecretsError on anything that would not boot. Running this before
    a single byte is pushed is the whole point: the alternative is finding
    out from journalctl on a box already serving the public intake form to
    a dead API.

    The master key is checked first because it is the only one of the three
    whose mistake cannot be undone afterwards.
    """
    validate_master_key(env.get("CRYPTO_MASTER_KEY", ""))
    validate_role_passwords(env)
    return validate_email_config(env)


def fingerprint_refusal(
    local_fp: str, remote_fp: str, secrets_file: str, host: str
) -> str:
    """"" when it is safe to write this .env; the refusal text otherwise.

    An empty remote fingerprint is a box with no .env yet -- a first
    deployment, not a mismatch. Neither key is ever printed; only the two
    eight-character fingerprints, which is enough for an operator to tell
    which secrets file they meant.
    """
    remote_fp = (remote_fp or "").strip()
    local_fp = (local_fp or "").strip()
    if not remote_fp or remote_fp == local_fp:
        return ""
    return (
        "FATAL: %s does not belong to %s.\n"
        "       Its CRYPTO_MASTER_KEY (%s) differs from the one already on the\n"
        "       box (%s); deploying would orphan every encrypted setting in\n"
        "       app_settings -- they are encrypted with the key on the box and\n"
        "       nothing can decrypt them afterwards.\n"
        "       Choose the right one with SECRETS_FILE=deploy/.secrets.<host>.env"
        % (secrets_file, host, local_fp, remote_fp)
    )


def deploy_needs() -> dict:
    """Bytes required per path for a deployment."""
    return {INSTALL_PREFIX: DEPLOY_BYTES}


def provision_needs() -> dict:
    """Bytes required per path for a provisioning run.

    The packages land under /usr; the downloads that produce them land in
    /var/cache/dnf. On a box with a separate /var those are two different
    filesystems, and a budget that names only /usr will happily approve a
    /var with no room for the download.
    """
    return {
        "/usr": PROVISION_INSTALL_BYTES,
        "/var/cache": PROVISION_CACHE_BYTES,
    }


def budget_refusal(refusals: list, breakdown: str = "") -> str:
    """Turn check_budget's strings into the refusal an operator can act on.

    "" when there is room. Otherwise the mount, both numbers, where the
    space goes, and where to look for space to reclaim -- because a refusal
    that names none of those is just a slower failure.
    """
    if not refusals:
        return ""
    lines = ["FATAL: " + refusals[0]]
    for extra in refusals[1:]:
        lines.append("       " + extra)
    if breakdown:
        lines.append("       (%s)" % breakdown)
    lines.append("       See: python3 deploy/dsr_deploy.py doctor --disk")
    return "\n".join(lines)


def deploy_breakdown() -> str:
    return "node_modules ~%s, dist ~%s, transfer headroom ~%s" % (
        human_bytes(DEPLOY_NODE_MODULES_BYTES),
        human_bytes(DEPLOY_DIST_BYTES),
        human_bytes(DEPLOY_TRANSFER_HEADROOM_BYTES),
    )


# (directory, the file a finished build leaves behind, the inputs that make it
# stale). The marker is a real artefact rather than a stamp file: a half-built
# dist that was interrupted has no main.js, so the next run rebuilds it.
BUILD_TARGETS = (
    ("server", "dist/main.js", "src tsconfig.json tsconfig.build.json package.json package-lock.json nest-cli.json"),
    ("apps/admin", "dist/index.html", "src public index.html package.json package-lock.json vite.config.ts"),
    ("apps/public-form", "dist/index.html", "src public index.html package.json package-lock.json vite.config.ts"),
)


def build_command(marker: str, inputs: str) -> str:
    """Install if the lockfile moved, build if any input is newer than the build.

    Both halves are shell tests rather than Python, because the answer has to
    be taken on the box at the moment the step runs -- `--dry-run` prints this
    command, and it must be the same command that later decides.

    `npm ci` is the slow part of a redeploy: it deletes node_modules and
    reinstalls all three trees, minutes on one core, and after a `git pull`
    that changed one component it is usually wasted. It is skipped when
    node_modules exists and package-lock.json is no newer than it -- which is
    exactly the condition under which `npm ci` would reinstall the same tree.

    `find <inputs> -newer <marker>` answers the build half. No match means
    nothing has changed since the artefact was written, so there is nothing
    to do. A missing marker makes `find` fail, which falls through to a
    build -- the safe direction.
    """
    return (
        "{ [ -d node_modules ] && [ ! package-lock.json -nt node_modules ] "
        "&& echo 'dependencies unchanged' "
        "|| npm ci --no-audit --no-fund; } && "
        "{ [ -f %s ] && [ -z \"$(find %s -newer %s 2>/dev/null | head -1)\" ] "
        "&& echo 'build is up to date' "
        "|| npm run build; }" % (marker, inputs, marker)
    )


def build_commands(root: str) -> list:
    """(directory, command) for each bundle, skipping what is already current.

    A string rather than an argv list because on Windows -- where this tool
    was run from Git Bash before it moved onto the box -- `npm` is a `.cmd`
    shim that only a shell resolves. Nothing operator-supplied reaches it.
    """
    return [
        (os.path.join(root, name), build_command(marker, inputs))
        for name, marker, inputs in BUILD_TARGETS
    ]


def deploy_payload(root: str) -> list:
    """Every path copied out of the checkout, and where it lands.

    The same set deploy.sh syncs, in the same order. Note what is not here:
    UPLOADS_DIR is never a destination. copy_dir mirrors a directory by
    removing it first, so listing the uploads directory here would delete
    identity documents held as regulatory records -- which is why the
    destinations are a data structure a test can walk rather than a
    sequence of calls buried in cmd_deploy.
    """
    def local(*parts):
        return os.path.join(root, *parts)

    return [
        PayloadItem("dir", local("server", "dist"), "%s/server/dist" % INSTALL_PREFIX),
        PayloadItem(
            "dir", local("server", "drizzle"), "%s/server/drizzle" % INSTALL_PREFIX
        ),
        PayloadItem(
            "dir", local("server", "scripts"), "%s/server/scripts" % INSTALL_PREFIX
        ),
        PayloadItem("dir", local("form-schema"), "%s/form-schema" % INSTALL_PREFIX),
        PayloadItem(
            "dir", local("apps", "public-form", "dist"), "%s/public-form" % WEB_ROOT
        ),
        PayloadItem("dir", local("apps", "admin", "dist"), "%s/admin" % WEB_ROOT),
        PayloadItem(
            "file",
            local("server", "package.json"),
            "%s/server/package.json" % INSTALL_PREFIX,
        ),
        PayloadItem(
            "file",
            local("server", "package-lock.json"),
            "%s/server/package-lock.json" % INSTALL_PREFIX,
        ),
    ]


def health_command() -> str:
    """One probe: the unit is up *and* the port answers.

    `is-active` alone passes while Nest is still binding, and curl alone
    passes against a stale process, so both.
    """
    return "systemctl is-active --quiet %s && curl -sf -o /dev/null http://127.0.0.1:%d/" % (
        SERVICE,
        APP_PORT,
    )


def poll_delay(attempt: int, attempts: int = HEALTH_ATTEMPTS,
               interval: int = HEALTH_INTERVAL_SECONDS):
    """Seconds to wait before the next probe, or None when that was the last.

    `attempt` is 1-based. Returning None is the give-up condition, and it is
    a separate function because it is the part that is easy to get wrong in
    two directions at once: an off-by-one that probes nineteen times, and a
    final sleep of three seconds after a result nobody is waiting for.
    """
    if attempt >= attempts:
        return None
    return interval


def step_failure_message(name: str, returncode: int, stderr: str, stdout: str = "") -> str:
    """What a failed step prints: which step, which exit code, what it said.

    Falls back to the tail of stdout when stderr is empty, because `dnf`,
    `psql` and `nginx -t` all say the useful thing on stdout and a refusal
    that names only an exit code sends the operator to the box to find out
    what this already knew.
    """
    lines = ["FATAL: step failed: %s (exit %d)" % (name, returncode)]
    detail = (stderr or "").strip()
    if not detail:
        detail = "\n".join((stdout or "").strip().splitlines()[-5:])
    if not detail:
        detail = "the command printed nothing; try it by hand in a shell"
    for line in detail.splitlines():
        lines.append("       " + line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# doctor
#
# Every check is two pieces. A *collector* runs one command on the box and
# hands back whatever it printed. An *evaluator* is a pure function from that
# text to a list of Finding. Only the evaluators are tested, and they are
# tested against captured-looking output pasted into the test file, because
# an evaluator that shells out is an evaluator that cannot be tested.
#
# The reason this mode exists: deploy/smoke.mjs tests the portal from outside
# over HTTPS, so it can report *that* the portal is broken but never *why*.
# The commonest RHEL failure is a 502 whose only trace is one nginx line --
# "Permission denied while connecting to upstream" -- which names neither
# SELinux nor the boolean that would fix it.
# ---------------------------------------------------------------------------

DOCTOR_GROUPS = ("host", "disk", "database", "service", "web", "selinux")

SELINUX_BOOLEAN = "httpd_can_network_connect"
SELINUX_FIX = "setsebool -P %s on" % SELINUX_BOOLEAN

# What the web root has to be labelled for nginx to be allowed to read
# it. A directory moved into place rather than created there keeps the
# context it came from -- admin_home_t after a `mv` out of /root -- and
# every request then answers 403 with nothing in the nginx log naming
# SELinux.
WEB_ROOT_CONTEXT = "httpd_sys_content_t"


def redact_url(text: str) -> str:
    """Blank the password out of any connection string in `text`.

    Command output reaches a Finding in a few places -- a psql error, an
    nginx error -- and any of it can carry a URL with credentials. A finding
    is printed, logged and pasted into chat; nothing in one may be a secret.

    This is a filter over arbitrary text, so it is best-effort by nature: a
    password handed over as `?password=` is not a match for any rule about
    userinfo. Where the URL is the subject rather than something buried in an
    error message, use describe_url, which never reads the secret at all.

    The password runs from the first `:` after the scheme to the *last* `@`
    in the token, and it crosses `/`. Both are deliberate. An `@` inside the
    password is ordinary; so is a `/`, which is one of the three characters
    `openssl rand -base64` emits and which the earlier password class stopped
    at, leaving the tail of the password in plain sight. The username class
    excludes `@` so that a second URL later on the line cannot be swallowed,
    and it allows the empty string, because `postgres://:pw@host` is a legal
    URL that the earliest form left untouched.

    The cost is over-redaction: `postgres://h:5432/db,notify=root@localhost`
    carries no password at all, yet the `@` at the end makes the whole middle
    look like one and it is starred out. That is the direction to err in.
    `a:b/c@d` is genuinely ambiguous -- password `b/c`, or path `/c` and a
    stray `@d` -- and a redactor that resolves the ambiguity in favour of
    printing loses a password the one time it is wrong. Stopping the password
    at whitespace keeps the over-redaction inside a single token.

    The same cost shows up unprompted by any postgres URL at all: an npm
    install failure logs
    `npm ERR! request to https://registry.npmjs.org:443/@nestjs/core failed`,
    and the port-then-`/@scope` sequence matches the password pattern just
    as well as a real one does, becoming
    `...npmjs.org:***@nestjs/core failed`. The unscoped form (no leading
    `@org/`) is not a match and passes through untouched. This is the same
    trade as the paragraph above, paid on a line with no secret in it at
    all, and the regex is not worth narrowing to avoid it: the alternative
    is a pattern that also stops matching some shape of a real password.
    """
    return re.sub(r"(://[^\s:/@]*):[^\s]*@", r"\1:***@", text or "")


# The shortest run of a secret worth blanking out of a log on its own. Below
# this a "fragment" is a coincidence, and blanking coincidences is how a
# redactor stops being readable and starts being ignored.
SCRUB_FRAGMENT = 8


def scrub(text: str, values) -> str:
    """Blank out any of `values` that appears anywhere in `text`.

    redact_url is a filter over the *shape* of a connection string, so it
    only catches a secret that arrives wearing one. The mutating half of
    this tool stages the real passwords and then prints command output that
    can carry them in any shape at all -- a psql `LINE n:` echo of a
    dollar-quoted block, twenty-five lines of journal. When the exact secret
    is in hand, the exact secret is what to look for.

    Longest first, so a password that contains another value does not get
    half-replaced and leave a recognisable remainder. Values shorter than
    six characters are skipped: `dsr` or `on` would star out half the log
    and tell the operator nothing, and a secret that short is a different
    problem. Anything falsy is skipped too -- replacing "" would insert
    `***` between every character in the text.

    Large *fragments* go too, not only whole values, because the carrier
    this exists for does not echo whole values. psql reports a parse error
    as `syntax error at or near "xK9pQzSecret"`, and that token is the tail
    of a password whose `$$` pair ended the dollar-quoted block early: the
    `LINE n:` echo below it holds the whole password and is caught, while
    the token above it is twelve of its fifteen characters and is not. A
    fragment counts once it is at least eight characters *and* at least
    half the secret. Both halves of that matter -- eight alone would blank
    every occurrence of an ordinary word inside a weak password and shred
    the log the operator is reading, and half alone would blank three
    characters of a six-character value.

    `values` in practice is not only the passwords: both call sites pass
    every value in the whole secrets mapping, not just the keys a step
    actually staged onto the box, so PRIVACY_MAILBOX, GRAPH_TENANT_ID and
    plain `production`-style config strings go through this same fragment
    treatment whenever they run six characters or long enough. That is
    safe by construction -- scrubbing a non-secret costs nothing but
    readability -- and arguably the right default given how easily a
    future secret could be added to that mapping and missed here. But it
    means the fragment rule's readability cost above is paid on more of
    the mapping than "the real passwords" suggests.
    """
    text = text or ""
    needles = set()
    for value in {str(v) for v in values or () if v and len(str(v)) >= 6}:
        needles.add(value)
        least = max(SCRUB_FRAGMENT, len(value) // 2)
        for start in range(len(value)):
            for end in range(start + least, len(value) + 1):
                needles.add(value[start:end])
    for needle in sorted(needles, key=len, reverse=True):
        text = text.replace(needle, "***")
    return text


# The fixed refusal string. A module constant rather than a literal repeated
# at every `return` in describe_url, so a caller (doctor's DATABASE_URL
# check, among others) can tell "refused to parse" apart from a real answer
# without restating the string and risking the two drifting apart.
UNPARSEABLE_URL = "unparseable connection string"


def describe_url(value: str) -> str:
    """`host:port/database` out of a connection string. Never the credentials.

    Constructing the answer out of named parts is safer than filtering the
    whole string, but it is not safe on its own, and an earlier version of
    this docstring claimed that it was. `urlsplit` ends the netloc at the
    first `/`, so a `/` inside the password -- one of the three characters
    `openssl rand -base64` emits -- moves the rest of the password into
    `.path`, and `.path` is what this function prints as the database name:

        postgres://dsr:7/xK9pQ@127.0.0.1:5432/dsr
            -> host `dsr`, port 7, path `/xK9pQ@127.0.0.1:5432/dsr`

    A construction is only as trustworthy as the parts it is built from, so
    the two parts that get printed are checked against what a host and a
    database name can actually contain before either one is, and the `@` is
    checked to be where the netloc is. Anything else becomes the fixed
    string, and nothing derived from the input is echoed back.

    A URL with no path at all -- `postgres://host:5432`, which libpq accepts
    and defaults to a database named after the connecting role -- is a
    legitimate shape, not a malformed one, so it is not folded into the same
    refusal a bad host or database name gets. It prints as `host:port/?`:
    `?` is already this function's placeholder for "not named" (a missing
    host prints the same way), and a distinct message for "no database was
    given" would be one more string for a caller to special-case for no
    operator benefit. A missing *host*, by contrast, still refuses -- `?` is
    where the answer is asking for scrutiny, not where it stands in for an
    everyday omission.
    """
    try:
        parsed = urlsplit(value or "")
        if not parsed.scheme:
            # Without a scheme this is not a URL, and echoing it back would
            # print whatever the env file actually holds -- which, for a
            # malformed value, can be the bare password.
            return UNPARSEABLE_URL
        host = parsed.hostname or "?"
        port = parsed.port or 5432
    except ValueError:
        # A non-numeric port makes .port raise rather than return None.
        return UNPARSEABLE_URL
    if not re.match(r"^[A-Za-z0-9_.:\[\]-]+$", host):
        # A host that is not a name, an IPv4 address or a bracketed IPv6 one
        # means the split did not land where the shape of the string
        # suggests it did.
        return UNPARSEABLE_URL
    database = (parsed.path or "/").lstrip("/") or "?"
    if database != "?" and not re.match(r"^[A-Za-z0-9_$-]+$", database):
        # A database name outside the identifier characters -- but not the
        # `?` this function put there itself for "no path given".
        return UNPARSEABLE_URL
    if "@" in (value or "") and "@" not in (parsed.netloc or ""):
        # The separator between the credentials and the host ended up outside
        # the netloc, so whatever `urlsplit` called the netloc is not it. A `#`
        # or a `?` in the password does this while leaving both parts above
        # looking respectable: `postgres://dsr:7/ab#cd@h/dsr` splits into host
        # `dsr`, port 7, path `/ab` -- and `ab` is half of the password.
        return UNPARSEABLE_URL
    return "%s:%s/%s" % (host, port, database)


# What a collector prints instead of an answer when it could not run at all.
# Folding stderr into stdout is what makes these visible; without it the
# complaint is discarded and the empty result reads as a clean log, which is
# a diagnostic asserting health on the strength of having read nothing.
_UNREADABLE_MARKERS = (
    "command not found",
    "Permission denied",
    "Error opening",
    # A collector that blocked. Without this a single command waiting on
    # something -- psql on a password prompt, a mount that stopped answering --
    # hangs the whole verification step with no output and no way to tell
    # which one, which is exactly what happened on the first real run.
    "collector timed out",
)

# No collector is worth waiting on for longer than this. Every one of them is
# a read that should answer immediately.
COLLECTOR_TIMEOUT_SECONDS = 30


def _unreadable(text: str) -> bool:
    """True when `text` is a collector's complaint rather than its output."""
    return any(marker in (text or "") for marker in _UNREADABLE_MARKERS)


def evaluate_selinux(getenforce: str, booleans: str, avc: str, webroot: str = "") -> list:
    """Read `getenforce`, `getsebool` and `ausearch` output.

    Nothing here ever suggests turning SELinux off. That is the fix people
    reach for, it is wrong, and on a box holding scanned identity documents
    it trades a five-second boolean for a permanent loss of confinement.
    """
    group = "selinux"
    findings = []

    mode = (getenforce or "").strip()
    mode = mode.splitlines()[0].strip() if mode else ""
    if mode == "Enforcing":
        findings.append(Finding(group, OK, "SELinux is enforcing", "", ""))
    elif mode == "Permissive":
        findings.append(
            Finding(
                group,
                WARN,
                "SELinux is not enforcing",
                "Denials are logged but allowed, so the portal appears to work "
                "while its confinement does nothing. This box stores scanned "
                "identity documents.",
                "Clear the denials below, then restore enforcement: "
                "setenforce 1, and SELINUX=enforcing in /etc/selinux/config",
            )
        )
    elif mode == "Disabled":
        findings.append(
            Finding(
                group,
                WARN,
                "SELinux is switched off entirely",
                "No policy is loaded, so no denial is even recorded. This box "
                "stores scanned identity documents.",
                "Set SELINUX=enforcing in /etc/selinux/config, then: "
                "touch /.autorelabel && reboot",
            )
        )
    else:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the SELinux mode",
                "`getenforce` printed %s."
                % (repr(mode) if mode else "nothing"),
                "getenforce",
            )
        )

    state = re.search(r"%s\s*-->\s*(on|off)" % SELINUX_BOOLEAN, booleans or "")
    if state is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the %s boolean" % SELINUX_BOOLEAN,
                "This is the one setting that decides whether nginx may reach "
                "the app at all, so an unreadable answer is not a pass.",
                "getsebool %s" % SELINUX_BOOLEAN,
            )
        )
    elif state.group(1) == "off":
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx is not allowed to connect to the app (%s is off)"
                % SELINUX_BOOLEAN,
                "Every request to the portal answers 502, and the only trace "
                "is one nginx line: Permission denied while connecting to "
                "upstream. It names neither SELinux nor this boolean, which "
                "is why the failure is unguessable.",
                SELINUX_FIX,
            )
        )
    else:
        findings.append(
            Finding(group, OK, "%s is on" % SELINUX_BOOLEAN, "", "")
        )

    # Only the type is read out, never the whole line: an evaluator that
    # echoes command output back is an evaluator that prints whatever the
    # command happened to say.
    label = re.search(r":([a-z_]+_t):", webroot or "")
    if label is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the SELinux label of %s" % WEB_ROOT,
                "`ls -Zd` answered without a context, so whether nginx is "
                "allowed to read the built portal is unknown. The directory "
                "may not exist yet.",
                "ls -Zd %s" % WEB_ROOT,
            )
        )
    elif label.group(1) != WEB_ROOT_CONTEXT:
        findings.append(
            Finding(
                group,
                FAIL,
                "%s has the wrong SELinux file context" % WEB_ROOT,
                "Labelled %s, not %s. nginx is refused every file under it "
                "and the portal answers 403 -- and that label is what a `mv` "
                "into place leaves behind, because a moved file keeps the "
                "context of where it came from."
                % (label.group(1), WEB_ROOT_CONTEXT),
                "restorecon -Rv %s" % WEB_ROOT,
            )
        )
    else:
        findings.append(
            Finding(
                group, OK, "%s is labelled %s" % (WEB_ROOT, WEB_ROOT_CONTEXT), "", ""
            )
        )

    # Checked before the denial scan, because "Permission denied" contains
    # the word the scan looks for.
    #
    # `or not .strip()`: an empty body reached the scan, found no "denied"
    # in it, and reported `ok  no recent SELinux denials` -- a diagnosis
    # asserting health on the strength of having read nothing. This is the
    # guard evaluate_service already has for the journal, added by 082bee9,
    # "Stop an unread log being reported as a clean one", and not carried
    # across. ausearch prints `<no matches>` on a genuinely empty audit log,
    # so the healthy path is not the empty one.
    if _unreadable(avc) or not (avc or "").strip():
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the audit log",
                "ausearch printed nothing at all, or an error rather than "
                "denials, so the absence of denials here is not evidence that "
                "there are none -- a clean log says `<no matches>`. auditd may "
                "not be installed or running.",
                "ausearch -m avc -ts recent -i",
            )
        )
        return findings

    denials = [line for line in (avc or "").splitlines() if "denied" in line]
    if denials:
        who = sorted(set(re.findall(r'comm="([^"]+)"', avc or "")))
        what = sorted(set(re.findall(r"\{\s*([a-z_]+(?:\s+[a-z_]+)*)\s*\}", avc or "")))
        findings.append(
            Finding(
                group,
                WARN,
                "%d recent SELinux denial%s"
                % (len(denials), "" if len(denials) == 1 else "s"),
                "Blocked: %s. Process: %s. Something the portal needs is "
                "being refused by policy."
                % (", ".join(what) or "unknown", ", ".join(who) or "unknown"),
                "ausearch -m avc -ts recent -i     "
                "(then set the boolean the denial points at -- never a blanket "
                "policy change)",
            )
        )
    else:
        findings.append(Finding(group, OK, "no recent SELinux denials", "", ""))

    return findings


# A service that is up but restarting every few seconds is a different
# problem from one that is simply down, and it needs a different first move:
# starting it again just feeds the loop.
CRASH_LOOP_RESTARTS = 3

# Journal lines are never quoted into a Finding -- a stack trace can print a
# connection string with its password. Each signature is matched, and the
# advice is written out here instead.
_JOURNAL_SIGNATURES = (
    (
        "CRYPTO_MASTER_KEY",
        "CRYPTO_MASTER_KEY is rejected at startup",
        "The API validates the key before it listens and exits if it is "
        "wrong, so systemd restarts it forever and nginx proxies the public "
        "form to a dead port.",
        "The key must base64-decode to exactly 32 bytes: openssl rand "
        "-base64 32. A 64-character hex string is the usual mistake.",
    ),
    (
        "EADDRINUSE",
        "port %d is already taken" % APP_PORT,
        "Another process is bound to the port the API wants, so it exits "
        "immediately.",
        "ss -lntp | grep %d" % APP_PORT,
    ),
    (
        "password authentication failed",
        "the database refused the API's password",
        "RHEL's stock pg_hba.conf answers loopback connections with `ident`, "
        "under which a password authenticates against nothing.",
        "Make the 127.0.0.1/32 and ::1/128 host rows in %s use scram-sha-256, "
        "then: systemctl reload postgresql" % PG_HBA_REMOTE,
    ),
    (
        "no pg_hba.conf entry",
        "pg_hba.conf has no rule for the API's connection",
        "Postgres rejected the connection before checking any password.",
        "Add a host rule for 127.0.0.1/32 with scram-sha-256 in %s, then: "
        "systemctl reload postgresql" % PG_HBA_REMOTE,
    ),
    (
        "ECONNREFUSED",
        "the API could not reach something it depends on",
        "A connection was refused outright at startup; postgres not running "
        "is the usual reason.",
        "systemctl status postgresql",
    ),
    (
        "GRAPH_",
        "the Graph mailer is not configured",
        "Email is environment-owned: with a credential missing the API exits "
        "at boot rather than starting unable to reach a data subject.",
        "Fill in PRIVACY_MAILBOX and the three GRAPH_ values, then redeploy.",
    ),
)

_JOURNAL_ERROR = re.compile(r"\b(error|fatal|exception|failed)\b", re.IGNORECASE)


def evaluate_service(is_active: str, show_output: str, journal: str) -> list:
    """Read `systemctl is-active`, `systemctl show -p NRestarts` and the journal."""
    group = "service"
    findings = []

    state = (is_active or "").strip()
    state = state.splitlines()[0].strip() if state else ""
    if state == "active":
        findings.append(Finding(group, OK, "%s is active" % SERVICE, "", ""))
    elif state in ("activating", "deactivating", "reloading"):
        findings.append(
            Finding(
                group,
                FAIL,
                "%s is %s, not running" % (SERVICE, state),
                "systemd caught it mid-cycle; on a settled box this state "
                "does not persist.",
                "journalctl -u %s -n 50 --no-pager" % SERVICE,
            )
        )
    else:
        findings.append(
            Finding(
                group,
                FAIL,
                "%s is not running (%s)" % (SERVICE, state or "state unknown"),
                "nginx has nothing to proxy to, so every request to the "
                "portal answers 502.",
                "systemctl start %s, then journalctl -u %s -n 50 --no-pager"
                % (SERVICE, SERVICE),
            )
        )

    counter = re.search(r"NRestarts=(\d+)", show_output or "")
    if counter is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the restart counter",
                "Without NRestarts a crash loop is indistinguishable from a "
                "healthy service, because systemd reports `active` for most "
                "of each restart cycle.",
                "systemctl show %s -p NRestarts" % SERVICE,
            )
        )
    else:
        restarts = int(counter.group(1))
        if restarts >= CRASH_LOOP_RESTARTS:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%s has restarted %d times (crash loop)" % (SERVICE, restarts),
                    "It exits on startup and systemd starts it again every few "
                    "seconds, so `is-active` calls it healthy. Starting it "
                    "again will not help; the env file is the usual cause.",
                    "journalctl -u %s -n 50 --no-pager, then check %s"
                    % (SERVICE, ENV_PATH),
                )
            )
        else:
            findings.append(
                Finding(
                    group,
                    OK,
                    "%s has restarted %d time%s"
                    % (SERVICE, restarts, "" if restarts == 1 else "s"),
                    "",
                    "",
                )
            )

    text = journal or ""
    matched = False
    for needle, title, detail, fix in _JOURNAL_SIGNATURES:
        if needle in text:
            matched = True
            findings.append(Finding(group, FAIL, title, detail, fix))
    if not matched:
        noisy = [line for line in text.splitlines() if _JOURNAL_ERROR.search(line)]
        if _unreadable(text) or not text.strip():
            # _JOURNAL_ERROR matches none of "journalctl: command not found",
            # so without this the complaint would score zero error lines and
            # be reported as a clean journal.
            findings.append(
                Finding(
                    group,
                    WARN,
                    "could not read the recent journal",
                    "journalctl returned nothing readable, so \"no errors\" "
                    "would be a claim about a log that was never read.",
                    "journalctl -u %s -n 50 --no-pager" % SERVICE,
                )
            )
        elif noisy:
            findings.append(
                Finding(
                    group,
                    WARN,
                    "%d error line%s in the last 25 journal lines"
                    % (len(noisy), "" if len(noisy) == 1 else "s"),
                    "Not quoted here: a journal line can contain a connection "
                    "string with its password.",
                    "journalctl -u %s -n 50 --no-pager" % SERVICE,
                )
            )
        else:
            findings.append(
                Finding(group, OK, "no errors in the recent journal", "", "")
            )

    return findings


# NODE_ENV and PORT are here because the unit file does not set them and the
# API reads them at startup; the two DATABASE_URLs because the app connects
# as the unprivileged role so row-level security applies to it.
_ENV_REQUIRED = (
    "NODE_ENV",
    "PORT",
    "DATABASE_URL",
    "DATABASE_URL_APP",
    "CRYPTO_MASTER_KEY",
)


def evaluate_env(env_text: str, mode: str) -> list:
    """Read the service .env and its permissions.

    Re-uses validate_master_key and validate_email_config rather than
    restating their rules: a second implementation of the 32-byte check is a
    second place for it to drift.

    Nothing read out of this file is ever placed in a Finding. It holds the
    crypto master key and two database passwords, and findings get printed,
    logged and pasted into chat.
    """
    group = "service"
    if not (env_text or "").strip():
        return [
            Finding(
                group,
                FAIL,
                "%s is missing or unreadable" % ENV_PATH,
                "The API has no database URL, no key and no mailer, so it "
                "exits at boot.",
                "Run a deploy: it writes this file from deploy/.secrets.env.",
            )
        ]

    findings = []
    digits = (mode or "").strip()
    if not digits.isdigit():
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the permissions of %s" % ENV_PATH,
                "`stat -c %%a` printed %s." % (repr(digits) if digits else "nothing"),
                "stat -c %%a %s" % ENV_PATH,
            )
        )
    else:
        perms = digits[-3:].zfill(3)
        if perms[1:] != "00":
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%s is mode %s -- readable beyond its owner" % (ENV_PATH, perms),
                    "It holds the crypto master key and both database "
                    "passwords. Every local account can read it.",
                    "chown dsr:dsr %s && chmod 600 %s" % (ENV_PATH, ENV_PATH),
                )
            )
        else:
            findings.append(
                Finding(group, OK, "%s is mode %s (owner only)" % (ENV_PATH, perms), "", "")
            )

    env = parse_env_text(env_text)
    missing = [key for key in _ENV_REQUIRED if not (env.get(key) or "").strip()]
    if missing:
        findings.append(
            Finding(
                group,
                FAIL,
                "%d required setting%s missing from the env file"
                % (len(missing), " is" if len(missing) == 1 else "s are"),
                "Missing: %s." % " ".join(missing),
                "Add them to deploy/.secrets.env and redeploy.",
            )
        )
    else:
        findings.append(
            Finding(group, OK, "every required setting is present", "", "")
        )

    raw = env.get("CRYPTO_MASTER_KEY", "")
    if raw.strip():
        try:
            validate_master_key(raw)
        except SecretsError as exc:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "CRYPTO_MASTER_KEY will not load",
                    str(exc),
                    "openssl rand -base64 32 -- but note that every stored "
                    "ciphertext was written under the key the API booted "
                    "with, so replacing it is not a free action.",
                )
            )
        else:
            findings.append(
                Finding(
                    group,
                    OK,
                    "CRYPTO_MASTER_KEY decodes to 32 bytes",
                    "fingerprint %s (a hash of the key, not the key)"
                    % key_fingerprint(raw),
                    "",
                )
            )

    try:
        warnings = validate_email_config(env)
    except SecretsError as exc:
        findings.append(
            Finding(
                group,
                FAIL,
                "the mailer is misconfigured and the API will exit at boot",
                str(exc),
                "Fix EMAIL_PROVIDER and the GRAPH_ values in "
                "deploy/.secrets.env, then redeploy.",
            )
        )
    else:
        for warning in warnings:
            findings.append(
                Finding(
                    group,
                    WARN,
                    "the mailer will not send",
                    warning,
                    "Set EMAIL_PROVIDER=graph with the four Graph values.",
                )
            )
        if not warnings:
            findings.append(
                Finding(group, OK, "the Graph mailer is fully configured", "", "")
            )

    for key in ("DATABASE_URL", "DATABASE_URL_APP"):
        value = (env.get(key) or "").strip()
        if not value:
            continue
        if not value.startswith("postgres://") and not value.startswith("postgresql://"):
            findings.append(
                Finding(
                    group,
                    WARN,
                    "%s does not look like a postgres URL" % key,
                    "node-postgres will not parse it.",
                    "postgres://user:password@127.0.0.1:5432/dsr",
                )
            )
        else:
            described = describe_url(value)
            if described == UNPARSEABLE_URL:
                # describe_url refused. That is not "nothing to report" --
                # the commonest way a postgres:// URL built by string
                # interpolation ends up unparseable is a URL-reserved
                # character sitting inside the password, and that is
                # precisely the failure validate_role_passwords exists to
                # keep out of a freshly-provisioned box. It reaches a
                # doctor run anyway when the .env was written by
                # deploy.sh's older, unguarded path. Never echo `value`
                # here: it is the connection string describe_url just
                # declined to vouch for, which is exactly the string that
                # can be carrying the raw password.
                findings.append(
                    Finding(
                        group,
                        WARN,
                        "%s could not be parsed" % key,
                        "Likely cause: the password it embeds contains "
                        "%s, which node-postgres reads as structure "
                        "rather than as a password character. The API "
                        "would fail to authenticate and systemd would "
                        "crash-loop it."
                        % " or ".join("`%s`" % c for c in URL_RESERVED_IN_PASSWORD),
                        PASSWORD_GENERATOR_ADVICE,
                    )
                )
            else:
                findings.append(
                    Finding(group, OK, "%s -> %s" % (key, described), "", "")
                )

    cookie = (env.get("COOKIE_SECURE") or "").strip().lower()
    if cookie and cookie != "true":
        findings.append(
            Finding(
                group,
                WARN,
                "COOKIE_SECURE is %s" % cookie,
                "The admin session cookie will be sent over plain HTTP.",
                "COOKIE_SECURE=true, once TLS is installed.",
            )
        )

    node_env = (env.get("NODE_ENV") or "").strip()
    if node_env and node_env != "production":
        findings.append(
            Finding(
                group,
                WARN,
                "NODE_ENV is %s, not production" % node_env,
                "Development paths behave differently and some guards are off.",
                "NODE_ENV=production",
            )
        )

    return findings


# The paths whose filesystem is worth watching. Two of them usually share a
# mount, which is exactly why mount_for resolves each one rather than
# assuming a layout.
DISK_WATCH = (INSTALL_PREFIX, UPLOADS_DIR, WEB_ROOT, "/var/lib/pgsql", "/var/log")

DISK_FAIL_FRACTION = 0.05
DISK_WARN_FRACTION = 0.15
DISK_FAIL_BYTES = 512 * 1024 * 1024
DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024

DISK_FIX = (
    "journalctl --vacuum-size=100M; npm cache clean --force; "
    "check %s for orphaned uploads" % UPLOADS_DIR
)


def evaluate_disk(df_text: str, samples: dict) -> list:
    """Report free space per watched mount, and growth where there is a baseline.

    `samples` is the recorded history: mountpoint -> [[epoch, used], ...].
    With fewer than two readings this says so rather than inventing a rate.
    """
    group = "disk"
    mounts = parse_df(df_text or "")
    if not mounts:
        return [
            Finding(
                group,
                WARN,
                "could not read the filesystem table",
                "`df -PB1` printed nothing this tool could parse.",
                "df -PB1",
            )
        ]

    watched = []
    seen = set()
    for path in DISK_WATCH:
        found = mount_for(path, mounts)
        if found is not None and found.mountpoint not in seen:
            seen.add(found.mountpoint)
            watched.append(found)
    if not watched:
        watched = mounts[:1]

    findings = []
    for mount in watched:
        fraction = float(mount.free) / mount.total if mount.total else 0.0
        if fraction < DISK_FAIL_FRACTION or mount.free < DISK_FAIL_BYTES:
            severity = FAIL
        elif fraction < DISK_WARN_FRACTION or mount.free < DISK_WARN_BYTES:
            severity = WARN
        else:
            severity = OK
        title = "%s has %s free (%d%% of %s)" % (
            mount.mountpoint,
            human_bytes(mount.free),
            round(fraction * 100),
            human_bytes(mount.total),
        )
        if severity == OK:
            findings.append(Finding(group, severity, title, "", ""))
        else:
            findings.append(
                Finding(
                    group,
                    severity,
                    title,
                    "A full filesystem stops postgres writing and stops the "
                    "portal accepting an upload, and both fail late.",
                    DISK_FIX,
                )
            )

    for mount in watched:
        series = (samples or {}).get(mount.mountpoint) or []
        if len(series) < 2:
            findings.append(
                Finding(
                    group,
                    OK,
                    "no growth baseline for %s yet" % mount.mountpoint,
                    "doctor records one reading per run and a projection "
                    "needs two, so there is no rate to report.",
                    "",
                )
            )
            continue
        left = project_days_until_full(series, mount.free)
        if left is None:
            findings.append(
                Finding(
                    group,
                    OK,
                    "%s is not growing" % mount.mountpoint,
                    "Usage is flat or falling across the recorded readings.",
                    "",
                )
            )
        elif left < 7:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%s fills in about %.0f days at the current rate"
                    % (mount.mountpoint, left),
                    "Measured between the first and last recorded readings.",
                    DISK_FIX,
                )
            )
        elif left < 30:
            findings.append(
                Finding(
                    group,
                    WARN,
                    "%s fills in about %.0f days at the current rate"
                    % (mount.mountpoint, left),
                    "Measured between the first and last recorded readings.",
                    DISK_FIX,
                )
            )
        else:
            findings.append(
                Finding(
                    group,
                    OK,
                    "%s has about %.0f days of headroom at the current rate"
                    % (mount.mountpoint, left),
                    "",
                    "",
                )
            )

    return findings


# ---------------------------------------------------------------------------
# disk: what is eating it, and what can honestly be given back
# ---------------------------------------------------------------------------

# "Which directory is eating the disk" without the operator guessing.
#
# -x stops du crossing a filesystem boundary, so a separate /var or a bind
# mount under the prefix is not counted against this one.
#
# --max-depth=1 limits the *output*, not the walk: du still stats every file
# under the uploads tree, and on a box holding a hundred thousand case files
# that takes real time. That cost is accepted deliberately. The flags that
# would avoid it are the flags that mutate -- `-delete`, `-exec`, anything
# that prunes or moves while measuring -- and doctor is read-only, over a
# tree of scanned identity documents. Nobody is to "optimise" this into a
# command that changes the box.
LARGEST_DIRS_COMMAND = "du -xb --max-depth=1 %s 2>&1" % INSTALL_PREFIX
LARGEST_DIRS_SHOWN = 5

# Reclaimable space, and only things that are genuinely reclaimable: caches
# that regenerate and logs that have already been read.
#
# Uploads and the Postgres cluster are the two largest things on this box and
# neither appears here. They are scanned identity documents and regulatory
# records; listing them under a heading an operator reads as "things you can
# delete" is how an accident starts.
DNF_CACHE_DIR = "/var/cache/dnf"
NPM_CACHE_DIR = "/root/.npm"
ENV_BACKUP_PATH = ENV_PATH + ".bak"

DNF_CACHE_COMMAND = "du -sb %s 2>&1" % DNF_CACHE_DIR
NPM_CACHE_COMMAND = "du -sb %s 2>&1" % NPM_CACHE_DIR
JOURNAL_USAGE_COMMAND = "journalctl --disk-usage 2>&1"
ENV_BACKUP_COMMAND = "stat -c %%s %s 2>&1" % ENV_BACKUP_PATH

DNF_CLEAN_FIX = "dnf clean all"
NPM_CLEAN_FIX = "npm cache clean --force"
JOURNAL_VACUUM_FIX = "journalctl --vacuum-size=100M"

# Worth telling an operator about on a ~10 GB box. Below it the report is
# still printed -- the number is the point -- but it is not a warning.
RECLAIM_WARN_BYTES = 256 * 1024 * 1024


def parse_du(text: str) -> list:
    """`du -b` output into [(bytes, path), ...], skipping anything else.

    With stderr folded in, du's complaints (`cannot read directory`) arrive
    on the same stream as its answers. A line that is not a number followed
    by a path is one of those, and skipping it is what lets a single
    unreadable subdirectory still produce a usable measurement.
    """
    rows = []
    for line in (text or "").splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            size = int(parts[0])
        except ValueError:
            continue
        rows.append((size, parts[1].strip()))
    return rows


def parse_size(text: str):
    """systemd's `96.0M` / `1.5G` / `512K` into bytes, or None.

    systemd formats these 1024-based, which is what human_bytes prints back.
    """
    found = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*([KMGT])?", text or "")
    if found is None:
        return None
    scale = {None: 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4}
    return int(float(found.group(1)) * scale[found.group(2)])


def is_uploads_path(path: str) -> bool:
    """True for the uploads directory itself or anything inside it."""
    cleaned = (path or "").rstrip("/")
    root = UPLOADS_DIR.rstrip("/")
    return cleaned == root or cleaned.startswith(root + "/")


def evaluate_largest_dirs(du_text: str) -> list:
    """The biggest directories directly under the install prefix.

    Reports sizes and nothing else. There is no fix on any finding here on
    purpose: the largest directory on this box is the uploads tree, and a
    "fix:" line beside it would read as a suggestion to delete case files.
    """
    group = "disk"
    rows = parse_du(du_text)
    if not rows:
        return [
            Finding(
                group,
                WARN,
                "could not measure the directories under %s" % INSTALL_PREFIX,
                "Without this, \"the disk is full\" names no cause.",
                LARGEST_DIRS_COMMAND.split(" 2>")[0],
            )
        ]

    prefix = INSTALL_PREFIX.rstrip("/")
    children = [row for row in rows if row[1].rstrip("/") != prefix]
    totals = [row[0] for row in rows if row[1].rstrip("/") == prefix]
    total = totals[0] if totals else sum(row[0] for row in children)

    children.sort(key=lambda row: (-row[0], row[1]))
    shown = children[:LARGEST_DIRS_SHOWN]
    listed = ", ".join(
        "%s %s" % (path[len(prefix) + 1:] or path, human_bytes(size))
        for size, path in shown
    )
    detail = "Largest: %s." % listed if listed else "Nothing underneath it."
    if any(is_uploads_path(path) for _size, path in shown):
        detail += (
            " The uploads tree is scanned identity documents and regulatory "
            "records; it is reported here, never reclaimed."
        )
    return [
        Finding(
            group,
            OK,
            "%s holds %s" % (prefix, human_bytes(total)),
            detail,
            "",
        )
    ]


def _measure_cache(text: str):
    """(bytes, state) for a `du -sb` capture: ok, absent, or unreadable."""
    rows = parse_du(text)
    if rows:
        return rows[0][0], "ok"
    if not (text or "").strip() or "No such file" in text:
        return 0, "absent"
    return 0, "unreadable"


def evaluate_reclaimable(
    dnf_cache: str, npm_cache: str, journal_usage: str, env_backup: str
) -> list:
    """Each reclaimable thing, its size, and the exact command that frees it.

    Nothing here is portal data. Uploads and the database are the two largest
    things on the box and neither is reclaimable, so neither is measured,
    named as a path, or given a command.
    """
    group = "disk"
    findings = []
    total = 0

    for label, text, command, fix, detail in (
        (
            "the dnf package cache",
            dnf_cache,
            DNF_CACHE_COMMAND,
            DNF_CLEAN_FIX,
            "Packages that are already installed. dnf re-downloads what it "
            "needs next time.",
        ),
        (
            "the npm cache",
            npm_cache,
            NPM_CACHE_COMMAND,
            NPM_CLEAN_FIX,
            "Tarballs npm can fetch again. deploy cleans this after npm ci; "
            "an interrupted deploy leaves it behind.",
        ),
    ):
        size, state = _measure_cache(text)
        if state == "ok":
            total += size
            findings.append(
                Finding(
                    group, OK, "%s is %s" % (label, human_bytes(size)), detail, fix
                )
            )
        elif state == "absent":
            findings.append(
                Finding(group, OK, "%s is empty or absent" % label, "", "")
            )
        else:
            findings.append(
                Finding(
                    group,
                    WARN,
                    "could not measure %s" % label,
                    "An unreadable answer is not the same as nothing to "
                    "reclaim, and on a full box the difference matters.",
                    command.split(" 2>")[0],
                )
            )

    journal_text = journal_usage or ""
    journal_bytes = None
    if not _unreadable(journal_text) and "take up" in journal_text:
        journal_bytes = parse_size(journal_text.split("take up", 1)[1])
    if journal_bytes is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not measure the journal",
                "journald defaults to a tenth of its filesystem, which on this "
                "box is most of a gigabyte of logs nobody has read.",
                "journalctl --disk-usage",
            )
        )
    else:
        total += journal_bytes
        findings.append(
            Finding(
                group,
                OK,
                "the systemd journal is %s" % human_bytes(journal_bytes),
                "Logs already written. Vacuuming keeps the most recent 100M "
                "and drops the rest.",
                JOURNAL_VACUUM_FIX,
            )
        )

    # Counted in nothing and given no command: it is the only rollback a
    # deployment has, and it is a few hundred bytes.
    stripped = (env_backup or "").strip()
    if stripped.isdigit():
        findings.append(
            Finding(
                group,
                OK,
                "the .env rollback copy is %s" % human_bytes(int(stripped)),
                "Not reclaimable and not counted above: it is the only "
                "rollback a deployment has, and it is smaller than this "
                "sentence.",
                "",
            )
        )
    else:
        findings.append(
            Finding(
                group,
                OK,
                "there is no .env rollback copy on this box yet",
                "deploy writes %s before it overwrites the live file."
                % ENV_BACKUP_PATH,
                "",
            )
        )

    findings.append(
        Finding(
            group,
            WARN if total >= RECLAIM_WARN_BYTES else OK,
            "about %s can be reclaimed without touching data" % human_bytes(total),
            "Caches and old logs only. Uploaded case files and the database "
            "are not in this figure and are not reclaimable: they are "
            "identity documents and regulatory records.",
            "; ".join((DNF_CLEAN_FIX, NPM_CLEAN_FIX, JOURNAL_VACUUM_FIX)),
        )
    )
    return findings


# openssl prints English month abbreviations whatever the box's locale is,
# while time.strptime("%b") follows LC_TIME and silently stops matching under
# a non-English one. Spelling the months out keeps this readable anywhere.
_MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

_NOT_AFTER = re.compile(
    r"notAfter\s*=\s*(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})"
)


def _parse_openssl_date(text: str):
    """`notAfter=Sep 10 00:00:00 2026 GMT` -> epoch seconds, or None."""
    found = _NOT_AFTER.search(text or "")
    if found is None:
        return None
    month = _MONTHS.get(found.group(1))
    if month is None:
        return None
    return calendar.timegm(
        (
            int(found.group(6)),
            month,
            int(found.group(2)),
            int(found.group(3)),
            int(found.group(4)),
            int(found.group(5)),
            0,
            0,
            0,
        )
    )


def evaluate_tls(cert_dates: str, now_epoch: int) -> list:
    """Read `openssl x509 -enddate -noout` output against a clock."""
    group = "web"
    text = (cert_dates or "").strip()
    if not text:
        return [
            Finding(
                group,
                WARN,
                "no TLS certificate is installed",
                "The portal is served over plain HTTP: session cookies and "
                "uploaded identity documents cross the network in the clear.",
                "deploy/enable-tls.sh, or deploy/enable-tls-ip.sh for a host "
                "with no domain name",
            )
        ]

    expiry = _parse_openssl_date(text)
    if expiry is None:
        return [
            Finding(
                group,
                WARN,
                "could not read the certificate expiry date",
                "`openssl x509 -enddate -noout` printed something this tool "
                "does not recognise.",
                "openssl x509 -enddate -noout -in "
                "/etc/letsencrypt/live/<name>/cert.pem",
            )
        ]

    days = (expiry - now_epoch) / 86400.0
    if days < 0:
        return [
            Finding(
                group,
                FAIL,
                "the TLS certificate expired %d days ago" % int(-days),
                "Browsers refuse the portal outright, and a data subject "
                "following an emailed link sees a security warning.",
                "certbot renew --force-renewal && systemctl reload nginx",
            )
        ]
    if days < 14:
        return [
            Finding(
                group,
                WARN,
                "the TLS certificate expires in %d days" % int(days),
                "Renewal is normally automatic; this close to the date it "
                "has not happened.",
                "systemctl list-timers | grep certbot, then: certbot renew",
            )
        ]
    return [
        Finding(
            group,
            OK,
            "the TLS certificate is valid for another %d days" % int(days),
            "",
            "",
        )
    ]


_PG_ERROR_MARKERS = (
    "psql: error",
    "FATAL:",
    "ERROR:",
    "could not connect",
    "Connection refused",
)


def _psql_error(text: str):
    """The first line of a psql failure, with any password removed."""
    for marker in _PG_ERROR_MARKERS:
        if marker in (text or ""):
            return redact_url(text.strip().splitlines()[0])
    return None


def evaluate_database(psql_roles: str, migrations_applied: str, migration_files: list) -> list:
    """Compare the roles and the applied migrations against what should be there.

    stdlib Python has no Postgres driver, so both inputs are `psql -tAc`
    output rather than query results.
    """
    group = "database"
    findings = []

    roles_text = psql_roles or ""
    error = _psql_error(roles_text)
    if error is not None:
        if "password authentication failed" in roles_text or "no pg_hba.conf entry" in roles_text:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "the database refused the connection",
                    "%s  RHEL's stock pg_hba.conf answers loopback with "
                    "`ident`, under which a password authenticates against "
                    "nothing -- Debian's default allowed password auth, which "
                    "is why this never came up before." % error,
                    "Make the 127.0.0.1/32 and ::1/128 host rows in %s use "
                    "scram-sha-256, then: systemctl reload postgresql"
                    % PG_HBA_REMOTE,
                )
            )
        else:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "could not query the database",
                    error,
                    "systemctl status postgresql",
                )
            )
    elif not roles_text.strip():
        findings.append(
            Finding(
                group,
                FAIL,
                "could not read the portal's database roles",
                "psql returned nothing at all, so the database is either "
                "down or unreachable from here.",
                "systemctl status postgresql",
            )
        )
    else:
        names = set(line.strip() for line in roles_text.splitlines() if line.strip())
        absent = [role for role in ("dsr", "dsr_app") if role not in names]
        if absent:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "database role%s missing: %s"
                    % ("" if len(absent) == 1 else "s", " ".join(absent)),
                    "dsr owns the schema; dsr_app is the unprivileged role the "
                    "API connects as, so that row-level security applies to it.",
                    "python3 deploy/dsr_deploy.py provision",
                )
            )
        else:
            findings.append(
                Finding(group, OK, "both database roles exist", "", "")
            )

    applied_text = migrations_applied or ""
    files = [name.strip() for name in (migration_files or []) if name.strip().endswith(".sql")]
    error = _psql_error(applied_text)
    if error is not None and "schema_migrations" in applied_text:
        findings.append(
            Finding(
                group,
                FAIL,
                "the schema_migrations table does not exist",
                "No migration has ever run here, so the API is talking to an "
                "empty or foreign schema and every query fails.",
                "cd %s/server && set -a && . ./.env && set +a && "
                "node scripts/migrate.mjs" % INSTALL_PREFIX,
            )
        )
    elif error is not None:
        findings.append(
            Finding(
                group,
                FAIL,
                "could not read the applied migrations",
                error,
                "cd %s/server && set -a && . ./.env && set +a && "
                "node scripts/migrate.mjs" % INSTALL_PREFIX,
            )
        )
    elif not files:
        findings.append(
            Finding(
                group,
                WARN,
                "could not list the migration files",
                "`ls %s/server/drizzle` returned nothing, so the applied set "
                "cannot be compared with anything." % INSTALL_PREFIX,
                "",
            )
        )
    else:
        applied = set(line.strip() for line in applied_text.splitlines() if line.strip())
        pending = [name for name in files if name not in applied]
        ahead = sorted(applied - set(files))
        if pending:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%d migration%s not applied"
                    % (len(pending), " is" if len(pending) == 1 else "s are"),
                    "Pending: %s." % " ".join(pending),
                    "cd %s/server && set -a && . ./.env && set +a && "
                    "node scripts/migrate.mjs" % INSTALL_PREFIX,
                )
            )
        elif ahead:
            findings.append(
                Finding(
                    group,
                    WARN,
                    "the database is ahead of the deployed code",
                    "Applied here but not present on disk: %s. The build on "
                    "this box is older than its schema." % " ".join(ahead),
                    "Deploy the current build.",
                )
            )
        else:
            findings.append(
                Finding(
                    group, OK, "all %d migrations are applied" % len(files), "", ""
                )
            )

    return findings


def evaluate_web(nginx_t: str, listeners: str) -> list:
    """Read `nginx -t` and `ss -lntp`."""
    group = "web"
    findings = []

    text = nginx_t or ""
    if "duplicate default server" in text:
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx has two default servers and will not start",
                "RHEL keeps its stock `listen 80 default_server` block inside "
                "/etc/nginx/nginx.conf itself rather than in a file you can "
                "delete, and conf.d/dsr.conf declares another one.",
                "python3 deploy/dsr_deploy.py provision edits the stock block "
                "out; then: nginx -t && systemctl reload nginx",
            )
        )
    elif "test is successful" in text:
        findings.append(Finding(group, OK, "nginx accepts its configuration", "", ""))
    elif not text.strip():
        findings.append(
            Finding(
                group,
                WARN,
                "could not run nginx -t",
                "The configuration may or may not be valid; nothing was "
                "printed.",
                "nginx -t",
            )
        )
    else:
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx rejects its configuration",
                redact_url(text.strip().splitlines()[0]),
                "nginx -t",
            )
        )

    if not (listeners or "").strip():
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the listening sockets",
                "`ss -lntp` printed nothing, so no port could be checked.",
                "ss -lntp",
            )
        )
        return findings

    ports = set(int(port) for port in re.findall(r":(\d+)\s", listeners))
    if APP_PORT not in ports:
        findings.append(
            Finding(
                group,
                FAIL,
                "nothing is listening on port %d" % APP_PORT,
                "nginx proxies to 127.0.0.1:%d; with nothing there every "
                "request answers 502." % APP_PORT,
                "systemctl status %s" % SERVICE,
            )
        )
    else:
        findings.append(
            Finding(group, OK, "the API is listening on %d" % APP_PORT, "", "")
        )

    if 80 not in ports:
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx is not listening on port 80",
                "The portal is unreachable, and certbot's HTTP challenge "
                "cannot complete either.",
                "nginx -t && systemctl status nginx",
            )
        )
    else:
        findings.append(Finding(group, OK, "nginx is listening on 80", "", ""))

    if 443 not in ports:
        findings.append(
            Finding(
                group,
                WARN,
                "nothing is listening on 443",
                "The portal is HTTP-only, so identity documents are uploaded "
                "in the clear.",
                "deploy/enable-tls.sh",
            )
        )
    else:
        findings.append(Finding(group, OK, "nginx is listening on 443", "", ""))

    return findings


# ---------------------------------------------------------------------------
# database: how big it is, and which table is making it so
# ---------------------------------------------------------------------------

# Beside the uploads tree this is the other thing on the box that only grows,
# and it is the one whose filesystem filling corrupts rather than merely
# annoys: Postgres does not degrade gracefully out of disk space.
#
# stdlib Python has no Postgres driver, so both of these are psql -tA output.
# -tA already separates columns with a pipe, so the query asks for two columns
# rather than concatenating them.
DB_SIZE_COMMAND = (
    "cd / && sudo -u postgres psql -tAc \"SELECT pg_database_size('dsr')\" 2>&1"
)

TABLE_SIZES_COMMAND = (
    "cd / && sudo -u postgres psql -d dsr -tAc \"SELECT c.relname, "
    "pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON "
    "n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' "
    "ORDER BY 2 DESC LIMIT 5\" 2>&1"
)

# On a ~10 GB box, worth saying out loud.
DB_SIZE_WARN_BYTES = 2 * 1024 * 1024 * 1024


def parse_table_sizes(text: str) -> list:
    """`relname|bytes` rows from psql -tA into [(name, bytes), ...].

    psql prints its errors on the same stream once stderr is folded in, and
    an error line is not two pipe-separated fields ending in a number.
    """
    rows = []
    for line in (text or "").splitlines():
        parts = line.strip().split("|")
        if len(parts) != 2 or not parts[1].strip().isdigit():
            continue
        name = parts[0].strip()
        if name:
            rows.append((name, int(parts[1].strip())))
    return rows


def evaluate_database_size(db_size: str, table_sizes: str) -> list:
    """Report the database size and its largest tables.

    A failure here is a WARN rather than a FAIL: when the database is
    unreachable the roles check above has already failed, and a second FAIL
    for the same cause is noise an operator has to read past.
    """
    group = "database"
    findings = []

    # The first all-digit line, not the first line: psql's own warnings
    # arrive on the same stream once stderr is folded in, and one of them
    # ahead of a perfectly good answer should not lose it. An error prints
    # no digits at all, which is what the empty case below means.
    digits = [
        line.strip()
        for line in (db_size or "").splitlines()
        if line.strip().isdigit()
    ]
    if not digits:
        findings.append(
            Finding(
                group,
                WARN,
                "could not measure the database",
                "Size and growth are how a full Postgres filesystem is seen "
                "coming rather than found afterwards.",
                "systemctl status postgresql",
            )
        )
    else:
        size = int(digits[0])
        big = size >= DB_SIZE_WARN_BYTES
        findings.append(
            Finding(
                group,
                WARN if big else OK,
                "the dsr database is %s" % human_bytes(size),
                "Beside the uploads tree this is the other thing here that "
                "only grows, and Postgres does not fail gracefully when its "
                "filesystem fills.",
                "python3 deploy/dsr_deploy.py doctor --disk" if big else "",
            )
        )

    rows = parse_table_sizes(table_sizes)
    if not rows:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the largest tables",
                "Without them, growth has a number but no cause.",
                "systemctl status postgresql",
            )
        )
    else:
        findings.append(
            Finding(
                group,
                OK,
                "largest tables: %s"
                % ", ".join("%s %s" % (name, human_bytes(size)) for name, size in rows),
                "Total relation size: the table, its indexes and its TOAST.",
                "",
            )
        )

    return findings


# ---------------------------------------------------------------------------
# web: the API as nginx sees it
# ---------------------------------------------------------------------------

# Two probes, and the pair is the point. Separately they are two facts; read
# together they are a diagnosis.
#
# The proxied probe is /public/ and not /, deliberately. `location /` serves
# the built public form off the disk, so http://127.0.0.1/ answers 200 with
# the API stopped -- it would pass straight through the fault it exists to
# catch. /public/ is proxied to 127.0.0.1:3000, so any HTTP status at all
# proves nginx reached the upstream, and 502 proves it did not.
#
# / is still probed, because a 403 there is the mislabelled web root and a
# 404 there is a bundle that never landed.
CURL_HEAD = (
    "curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "
)
API_DIRECT_COMMAND = CURL_HEAD + "http://127.0.0.1:%d/ 2>&1" % APP_PORT
API_PROXY_PATH = "/public/"
API_PROXY_COMMAND = CURL_HEAD + "http://127.0.0.1%s 2>&1" % API_PROXY_PATH
WEB_ROOT_COMMAND = CURL_HEAD + "http://127.0.0.1/ 2>&1"

# What nginx answers when it could not reach the thing it proxies to.
_UPSTREAM_FAILURE_CODES = (502, 503, 504)

_HTTP_CODE = re.compile(r"(\d{3})\s*$")


def parse_http_code(text: str):
    """The status curl printed, or None when curl never got that far.

    `-w '%{http_code}'` writes 000 when the connection failed, and with
    stderr folded in curl's own complaint arrives first. The code is the
    last thing on the stream either way.
    """
    found = _HTTP_CODE.search((text or "").strip())
    return int(found.group(1)) if found else None


def evaluate_proxy(api_direct: str, api_proxy: str, web_root: str) -> list:
    """The API directly, the API through nginx, and the form nginx serves.

    The differential lives here: an API that answers on 3000 and 502s on 80
    is not a broken API. It is an nginx that is not allowed to open a socket
    to it, which is what httpd_can_network_connect being off looks like from
    outside -- and the nginx error log names neither SELinux nor the boolean.
    """
    group = "web"
    findings = []

    direct = parse_http_code(api_direct)
    proxy = parse_http_code(api_proxy)
    root = parse_http_code(web_root)

    if direct is None and proxy is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not probe the portal from the box itself",
                "curl printed no status, so neither the API nor the proxy in "
                "front of it was actually tested.",
                "dnf install -y curl",
            )
        )
        return findings

    answered_direct = bool(direct) and direct != 0
    proxy_reached_upstream = (
        proxy is not None and proxy != 0 and proxy not in _UPSTREAM_FAILURE_CODES
    )

    if direct is None or proxy is None:
        # One probe that printed no status at all is not evidence about the
        # other. An unreadable answer is neither a pass nor a fault to name,
        # and naming the SELinux boolean off the back of one would be a
        # diagnosis built on nothing.
        findings.append(
            Finding(
                group,
                WARN,
                "could not probe the API %s"
                % ("directly" if direct is None else "through nginx"),
                "curl printed no status for that probe, so the pair that "
                "tells a blocked proxy apart from a dead API is incomplete.",
                (API_DIRECT_COMMAND if direct is None else API_PROXY_COMMAND).split(
                    " 2>"
                )[0],
            )
        )
    elif answered_direct and proxy_reached_upstream:
        findings.append(
            Finding(
                group,
                OK,
                "the API answers through nginx (%d on %s, %d direct)"
                % (proxy, API_PROXY_PATH, direct),
                "",
                "",
            )
        )
    elif answered_direct:
        findings.append(
            Finding(
                group,
                FAIL,
                "the API answers directly but not through nginx",
                "127.0.0.1:%d answered %d and http://127.0.0.1%s answered %s. "
                "The API is healthy; nginx cannot open a socket to it. From "
                "outside this is a 502 on every request with one line in the "
                "error log -- Permission denied while connecting to upstream "
                "-- which names neither SELinux nor the setting responsible. "
                "That is exactly what %s being off looks like: check the "
                "selinux group of this report."
                % (
                    APP_PORT,
                    direct,
                    API_PROXY_PATH,
                    "nothing" if proxy in (None, 0) else str(proxy),
                    SELINUX_BOOLEAN,
                ),
                "getsebool %s -- and if it is off: %s"
                % (SELINUX_BOOLEAN, SELINUX_FIX),
            )
        )
    elif proxy_reached_upstream:
        findings.append(
            Finding(
                group,
                WARN,
                "nginx answers for the API but the API does not answer directly",
                "http://127.0.0.1%s answered %d while 127.0.0.1:%d answered "
                "%s. nginx is serving something other than the API for that "
                "path."
                % (
                    API_PROXY_PATH,
                    proxy,
                    APP_PORT,
                    "nothing" if direct in (None, 0) else str(direct),
                ),
                "nginx -T | grep -A3 'location /public/'",
            )
        )
    else:
        findings.append(
            Finding(
                group,
                FAIL,
                "the API answers neither directly nor through nginx",
                "Both probes failed, so this is the service and not the proxy "
                "in front of it. The service group above says which.",
                "systemctl status %s" % SERVICE,
            )
        )

    if root is None or root == 0:
        findings.append(
            Finding(
                group,
                WARN,
                "could not reach the public form on port 80",
                "nginx answered nothing at all on the loopback address.",
                "systemctl status nginx",
            )
        )
    elif root == 403:
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx answers 403 for the public form",
                "nginx is running and refusing to read %s. The usual cause is "
                "the SELinux file context: a directory moved into place keeps "
                "the label it came from, and nginx is denied every file under "
                "it. The selinux group of this report says which label it has."
                % WEB_ROOT,
                "restorecon -Rv %s" % WEB_ROOT,
            )
        )
    elif root == 404:
        findings.append(
            Finding(
                group,
                WARN,
                "nginx answers 404 for the public form",
                "nginx is serving %s and there is no index.html in it, so the "
                "public bundle was never deployed." % WEB_ROOT,
                "python3 deploy/dsr_deploy.py deploy",
            )
        )
    elif root >= 500:
        findings.append(
            Finding(
                group,
                FAIL,
                "nginx answers %d for the public form" % root,
                "The public intake form is the page a data subject lands on.",
                "systemctl status nginx",
            )
        )
    else:
        findings.append(
            Finding(
                group, OK, "the public form answers %d on port 80" % root, "", ""
            )
        )

    return findings


def _version_number(text: str) -> str:
    """The dotted number out of `v22.11.0` or `psql (PostgreSQL) 16.2`."""
    found = re.search(r"(\d+(?:\.\d+)*)", text or "")
    return found.group(1) if found else (text or '').strip()


NODE_MINIMUM = "22"
# 13, matching PG_MAJOR_TEST. The schema needs gen_random_uuid() built in
# (PG13) and AS RESTRICTIVE policies (PG10) and nothing newer, so a host
# already running 13 is a host DSR runs on. This constant and PG_MAJOR_TEST
# must not drift: one refusing what the other accepts is how the first real
# deployment provisioned successfully and then failed its own verification.
POSTGRES_MINIMUM = "13"


def evaluate_host(os_release: str, node_version: str, psql_version: str) -> list:
    """Read /etc/os-release and the two runtime versions."""
    group = "host"
    findings = []

    text = os_release or ""
    if "platform:el9" in text:
        findings.append(Finding(group, OK, "the host is RHEL 9", "", ""))
    elif not text.strip():
        findings.append(
            Finding(
                group,
                WARN,
                "could not read /etc/os-release",
                "Nothing else here assumes a distribution, but a surprise "
                "here usually explains the rest.",
                "cat /etc/os-release",
            )
        )
    else:
        named = re.search(r'PRETTY_NAME="([^"]*)"', text)
        findings.append(
            Finding(
                group,
                WARN,
                "this host does not look like RHEL 9",
                "/etc/os-release says %s. The paths this tool uses -- "
                "/var/lib/pgsql/data, /etc/nginx/conf.d -- are RHEL's."
                % (named.group(1) if named else "something else"),
                "",
            )
        )

    for label, actual, minimum, install in (
        ("Node", node_version, NODE_MINIMUM,
         "dnf module enable -y nodejs:22 && dnf install -y nodejs"),
        ("PostgreSQL", psql_version, POSTGRES_MINIMUM,
         "dnf module enable -y postgresql:16 && dnf install -y postgresql-server"),
    ):
        got = (actual or "").strip()
        if version_at_least(got, minimum):
            findings.append(
                Finding(
                    group, OK, "%s %s is installed" % (label, _version_number(got)), "", ""
                )
            )
        elif got:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%s %s or newer is required; this host has %s"
                    % (label, minimum, _version_number(got)),
                    "",
                    install,
                )
            )
        else:
            findings.append(
                Finding(
                    group,
                    FAIL,
                    "%s is not installed, or not on PATH" % label,
                    "",
                    install,
                )
            )

    return findings


# ---------------------------------------------------------------------------
# host: RAM, and whether zram actually came back
# ---------------------------------------------------------------------------

# provision configures zram rather than a swapfile, because `fallocate -l 2G`
# would spend a fifth of this box's ~10 GB filesystem before a single package
# was installed. Compressed swap in RAM costs no disk at all.
#
# Nothing until now confirmed the unit was still there after a reboot, and a
# box with no swap of any kind is the box where `npm ci` on a single vCPU is
# OOM-killed halfway through -- which the kernel reports as a killed process,
# not as a failed install.
FREE_COMMAND = "free -b 2>&1"
SWAPON_COMMAND = "swapon --show --bytes 2>&1"

ZRAM_FIX = (
    "systemctl start systemd-zram-setup@zram0.service "
    "-- provision installs zram-generator and writes "
    "/etc/systemd/zram-generator.conf"
)

# Below this much RAM, no swap at all is a failure rather than a warning: it
# is the configuration under which npm ci is killed rather than slowed.
ZRAM_REQUIRED_BELOW_BYTES = 4 * 1024 * 1024 * 1024


def parse_free(text: str) -> dict:
    """`free -b` into {"ram": bytes}, or {} when the row is not there.

    Only the Mem: row is read. free's own Swap: row is deliberately ignored,
    because it says how much swap there is and the whole question here is
    what kind -- which only `swapon --show` answers.
    """
    for line in (text or "").splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[0].rstrip(":").lower() == "mem":
            try:
                return {"ram": int(fields[1])}
            except ValueError:
                return {}
    return {}


def parse_swapon(text: str) -> list:
    """`swapon --show --bytes` into [(name, kind, size), ...].

    Empty output is not a parse failure. It is precisely what a host with no
    swap prints, and that is the condition this check exists to find.
    """
    entries = []
    for line in (text or "").splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[0].upper() == "NAME":
            continue
        try:
            size = int(fields[2])
        except ValueError:
            continue
        entries.append((fields[0], fields[1], size))
    return entries


def evaluate_memory(free_text: str, swapon_text: str) -> list:
    """Report RAM, and whether swap is zram, a disk file, or absent."""
    group = "host"
    findings = []

    ram = parse_free(free_text).get("ram")
    if ram is None:
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the memory table",
                "`free -b` printed nothing this tool could parse, so the swap "
                "judgement below is made without knowing how much RAM there is.",
                "free -b",
            )
        )
    else:
        findings.append(
            Finding(group, OK, "the host has %s of RAM" % human_bytes(ram), "", "")
        )

    if _unreadable(swapon_text):
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the swap table",
                "An unreadable answer is not a pass: this is the check that "
                "says whether zram survived the last reboot.",
                "swapon --show --bytes",
            )
        )
        return findings

    entries = parse_swapon(swapon_text)
    zram = [entry for entry in entries if "zram" in entry[0].lower()]
    if zram:
        findings.append(
            Finding(
                group,
                OK,
                "zram swap is active (%s)" % human_bytes(sum(e[2] for e in zram)),
                "",
                "",
            )
        )
    elif entries:
        findings.append(
            Finding(
                group,
                WARN,
                "swap is on disk, not in zram",
                "%s costs the filesystem exactly what it is sized at. provision "
                "configures zram instead, because a 2 GiB swapfile is a fifth "
                "of this box." % ", ".join(entry[0] for entry in entries),
                ZRAM_FIX,
            )
        )
    else:
        findings.append(
            Finding(
                group,
                WARN if ram is None or ram >= ZRAM_REQUIRED_BELOW_BYTES else FAIL,
                "there is no swap on this host",
                "provision configures zram, so either it was never run here or "
                "the unit did not come back after a reboot. With no swap on a "
                "single-vCPU box, npm ci is the step the kernel runs out of "
                "memory during, and it kills the process rather than failing "
                "the install.",
                ZRAM_FIX,
            )
        )

    return findings


# ---------------------------------------------------------------------------
# doctor: collectors, state and the command itself
# ---------------------------------------------------------------------------

# Read-only, every one of them. doctor changes nothing on the box: no
# service, no config, no database row, no uploaded file. The only thing it
# writes anywhere is the disk sample below, and --no-state suppresses that.
DOCTOR_COMMANDS = (
    ("os_release", "cat /etc/os-release"),
    ("node_version", "node -v 2>&1"),
    ("psql_version", "psql --version 2>&1"),
    ("getenforce", "getenforce 2>&1"),
    ("sebool", "getsebool %s 2>&1" % SELINUX_BOOLEAN),
    # ausearch exits 1 when the audit log holds no denials, which is the good
    # case and not an error -- but 2>/dev/null also swallowed `command not
    # found` and permission errors, and the empty stdout that left behind was
    # then reported as a clean audit log. `<no matches>` contains no "denied",
    # so folding stderr in costs the healthy path nothing.
    ("avc", "ausearch -m avc -ts recent 2>&1"),
    ("is_active", "systemctl is-active %s" % SERVICE),
    ("nrestarts", "systemctl show %s -p NRestarts" % SERVICE),
    ("journal", "journalctl -u %s -n 25 --no-pager 2>&1" % SERVICE),
    ("df", "df -PB1"),
    ("memory", FREE_COMMAND),
    ("swaps", SWAPON_COMMAND),
    ("largest_dirs", LARGEST_DIRS_COMMAND),
    ("dnf_cache", DNF_CACHE_COMMAND),
    ("npm_cache", NPM_CACHE_COMMAND),
    ("journal_usage", JOURNAL_USAGE_COMMAND),
    ("env_backup", ENV_BACKUP_COMMAND),
    ("env_mode", "stat -c %%a %s 2>/dev/null" % ENV_PATH),
    ("env_text", "cat %s 2>/dev/null" % ENV_PATH),
    (
        "psql_roles",
        "cd / && sudo -u postgres psql -tAc \"SELECT rolname FROM pg_roles WHERE "
        "rolname IN ('dsr', 'dsr_app') ORDER BY rolname\" 2>&1",
    ),
    (
        "migrations",
        "cd / && sudo -u postgres psql -d dsr -tAc 'SELECT name FROM "
        "schema_migrations ORDER BY name' 2>&1",
    ),
    ("migration_files", "ls %s/server/drizzle 2>/dev/null" % INSTALL_PREFIX),
    ("db_size", DB_SIZE_COMMAND),
    ("table_sizes", TABLE_SIZES_COMMAND),
    (
        "cert",
        "DSR_CERT=$(ls /etc/letsencrypt/live/*/fullchain.pem 2>/dev/null | head -1); "
        "[ -n \"$DSR_CERT\" ] && openssl x509 -enddate -noout -in \"$DSR_CERT\"",
    ),
    # The fourth SELinux check the spec lists: a web root labelled
    # default_t or admin_home_t answers 403 and names nothing.
    ("webroot_context", "ls -Zd %s 2>&1" % WEB_ROOT),
    ("nginx_t", "nginx -t 2>&1"),
    ("listeners", "ss -lntp 2>&1"),
    ("api_direct", API_DIRECT_COMMAND),
    ("api_proxy", API_PROXY_COMMAND),
    ("web_root", WEB_ROOT_COMMAND),
)

# Read out of band rather than through collect(), because its result feeds
# the disk projection rather than an evaluator. A module constant so the
# "not one collector changes anything" sweep can see it: that guarantee is
# only worth as much as the set of commands it is allowed to look at.
STATE_READ_COMMAND = "cat %s 2>/dev/null" % STATE_PATH


class LocalRunner:
    """Runs collectors on this machine, which is the box.

    Separate from LocalTarget on purpose: a collector's answer is whatever
    it printed, so this returns text and never raises, while a step's answer
    is an exit code. Folding the two together would mean either a collector
    that can abort the diagnosis or a step whose failure goes unnoticed.

    A collector that fails is not an error. `ausearch -m avc -ts recent`
    exits 1 when there are no denials, which is the good case, and a missing
    binary is itself something an evaluator reports. Whatever the command
    managed to print is the answer.
    """

    def run(self, command: str) -> str:
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=COLLECTOR_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            # Reported, not raised. One unresponsive command should cost its
            # own finding, not the whole run -- and naming it beats a
            # verification step that sits there saying nothing.
            return "collector timed out after %ds" % COLLECTOR_TIMEOUT_SECONDS
        except OSError:
            return ""
        return result.stdout

    def write(self, path: str, text: str) -> None:
        try:
            destination = pathlib.Path(path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text)
        except OSError:
            # A read-only /var is a reason to skip the sample, not to fail
            # the diagnosis the operator asked for.
            pass


def collect(runner) -> dict:
    """Run every collector, keyed by name. Nothing is interpreted here."""
    return dict((name, runner.run(command)) for name, command in DOCTOR_COMMANDS)


def parse_state(text: str) -> dict:
    """The recorded samples, or {} for anything unreadable."""
    try:
        data = json.loads(text or "")
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    samples = data.get("samples")
    return samples if isinstance(samples, dict) else {}


def render_state(samples: dict) -> str:
    return json.dumps({"version": 1, "samples": samples}, sort_keys=True) + "\n"


def update_samples(samples: dict, mounts: list, now_epoch: int, keep: int = 30) -> dict:
    """Append one used-bytes reading per mount, keeping the last `keep`.

    Used is derived as total - free rather than read from df's Used column,
    which excludes root-reserved blocks. The absolute number matters less
    than that every sample is measured the same way.
    """
    updated = dict((key, list(value)) for key, value in (samples or {}).items())
    for mount in mounts:
        series = updated.setdefault(mount.mountpoint, [])
        series.append([int(now_epoch), int(mount.total - mount.free)])
        del series[:-keep]
    return updated


def assemble_findings(capture: dict, samples: dict, now_epoch: int) -> list:
    """Every evaluator, over one capture. Pure: no command runs here."""
    def get(name):
        return capture.get(name, "") or ""

    findings = []
    findings += evaluate_host(get("os_release"), get("node_version"), get("psql_version"))
    findings += evaluate_memory(get("memory"), get("swaps"))
    findings += evaluate_selinux(
        get("getenforce"), get("sebool"), get("avc"), get("webroot_context")
    )
    findings += evaluate_service(get("is_active"), get("nrestarts"), get("journal"))
    findings += evaluate_env(get("env_text"), get("env_mode"))
    findings += evaluate_disk(get("df"), samples)
    findings += evaluate_largest_dirs(get("largest_dirs"))
    findings += evaluate_reclaimable(
        get("dnf_cache"), get("npm_cache"), get("journal_usage"), get("env_backup")
    )
    findings += evaluate_database(
        get("psql_roles"),
        get("migrations"),
        [line.strip() for line in get("migration_files").splitlines() if line.strip()],
    )
    findings += evaluate_database_size(get("db_size"), get("table_sizes"))
    findings += evaluate_tls(get("cert"), now_epoch)
    findings += evaluate_web(get("nginx_t"), get("listeners"))
    findings += evaluate_proxy(
        get("api_direct"), get("api_proxy"), get("web_root")
    )
    return findings


def cmd_doctor(args, runner, now_epoch=None) -> int:
    """Collect, evaluate, print, and exit 0/1/2 on the worst severity seen."""
    if now_epoch is None:
        now_epoch = int(time.time())
    capture = collect(runner)

    no_state = getattr(args, "no_state", False)
    samples = {} if no_state else parse_state(runner.run(STATE_READ_COMMAND))

    findings = assemble_findings(capture, samples, now_epoch)
    selected = [group for group in DOCTOR_GROUPS if getattr(args, group, False)]
    if selected:
        findings = [f for f in findings if f.group in selected]

    if not no_state:
        runner.write(
            STATE_PATH,
            render_state(update_samples(samples, parse_df(capture.get("df", "")), now_epoch)),
        )

    sys.stdout.write(render_findings(findings, selected))
    return exit_code_for(findings)


def this_host() -> str:
    """The name to print for the box being changed: it is this one."""
    try:
        return socket.gethostname() or "this host"
    except OSError:
        return "this host"


def read_existing_env(path: str = ENV_PATH) -> dict:
    """Everything already in the service .env. {} when there is none yet.

    An unreadable .env is a refusal, not a first deployment. The two look
    identical to a caller that only checks for {} -- and the wrong answer
    costs the CRYPTO_MASTER_KEY that every encrypted row in app_settings was
    written with, which nothing recovers.
    """
    candidate = pathlib.Path(path)
    try:
        text = candidate.read_text()
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise SecretsError(
            "FATAL: %s exists but could not be read (%s).\n"
            "       Until its CRYPTO_MASTER_KEY is known, deploying could\n"
            "       write a different one, and every encrypted setting in\n"
            "       app_settings is unreadable from that moment on. An\n"
            "       unreadable .env is a refusal, not a first deployment."
            % (path, exc.strerror or exc)
        )
    return parse_env_text(text)


def secrets_path() -> pathlib.Path:
    """Which secrets file to read. SECRETS_FILE overrides, as deploy.sh."""
    override = (os.environ.get("SECRETS_FILE") or "").strip()
    if override:
        return pathlib.Path(override)
    return _DEPLOY_DIR / DEFAULT_SECRETS_NAME


def read_operator_secrets(path) -> dict:
    """The operator's file, or {} when it is not there yet.

    An absent file is not an error here: it is the case that writes the
    template and tells them where it is. Nothing read out of it is ever
    printed or logged.
    """
    candidate = pathlib.Path(path)
    if not candidate.is_file():
        return {}
    return parse_env_text(candidate.read_text())


def copy_self(target, out) -> None:
    """Put a copy of this file at REMOTE_SELF, before anything needs it.

    Two provisioning steps run `python3 /root/dsr_deploy.py` to apply the
    pg_hba and nginx rewrites, so that the same tested, idempotent,
    comment-aware transforms decide what changes -- never a sed re-deriving
    that logic, where a wrong regex leaves an unbalanced config file. The
    checkout this is running from may be anywhere; the copy is where the
    steps say it is.
    """
    out.write("copying the deployer to %s\n" % REMOTE_SELF)
    target.copy_file(str(pathlib.Path(__file__).resolve()), REMOTE_SELF)


def check_disk_budget(target, needs: dict, breakdown: str = "") -> None:
    """Measure the filesystems and refuse with the numbers, not halfway."""
    mounts = parse_df(target.run("df -PB1", check=False).stdout)
    if not mounts:
        # Better a warning than a refusal: a box whose df cannot be read is
        # not a box that is known to be full.
        sys.stderr.write("WARNING: could not read `df -PB1`; skipping the disk budget\n")
        return
    refusal = budget_refusal(check_budget(mounts, needs), breakdown)
    if refusal:
        raise Refusal(refusal)


def run_steps(target, steps: list, out, secrets: dict = None) -> None:
    """Execute a plan, naming each step, stopping at the first failure.

    `secrets` is the staged values, and it is not optional in practice. A
    step's stderr goes into the refusal verbatim, and the steps that fail
    are the ones handling passwords: the role step sends psql a `DO $$ ... $$`
    block with the expanded password inside it, and on a *parse* error psql
    echoes the offending line back as `LINE n:`. Doubling the apostrophes
    closed one trigger; `$$` inside a password is another, and there will be
    a third. The sink is the thing to close.
    """
    total = len(steps)
    for index, entry in enumerate(steps, 1):
        out.write("==> [%d/%d] %s\n" % (index, total, entry.name))
        out.flush()
        result = target.run(entry.command, check=False)
        if result.returncode != 0:
            raise Refusal(
                scrub(
                    redact_url(
                        step_failure_message(
                            entry.name, result.returncode, result.stderr, result.stdout
                        )
                    ),
                    (secrets or {}).values(),
                )
            )


def poll_health(target, out, sleep=None) -> bool:
    """Poll for the API, twenty times, three seconds apart.

    One probe is not enough: on a 1-vCPU box Nest can take well over four
    seconds to bind, and a single check reports a false failure on a
    deployment that actually worked. deploy.sh records exactly that.
    """
    if sleep is None:
        sleep = time.sleep
    for attempt in range(1, HEALTH_ATTEMPTS + 1):
        if target.run(health_command(), check=False).returncode == 0:
            out.write("==> healthy after %d probe%s\n" % (attempt, "" if attempt == 1 else "s"))
            return True
        delay = poll_delay(attempt)
        if delay is None:
            return False
        sleep(delay)
    return False


# ---------------------------------------------------------------------------
# The secrets the portal keeps to itself, and the one thing it must be told
# ---------------------------------------------------------------------------

# DB_PASS, APP_PASS and CRYPTO_MASTER_KEY are used by the portal to talk to
# itself: nobody types them, nothing else consumes them, and asking an
# operator to invent them buys nothing but a chance to invent a bad one.
# They are generated here.
GENERATED_KEYS = ("DB_PASS", "APP_PASS", "CRYPTO_MASTER_KEY")

# What the operator supplies in deploy/.secrets.env. The mail credentials
# belong to a tenant this tool cannot see; the last two have defaults and are
# there for the rare box that needs them.
OPERATOR_KEYS = GRAPH_KEYS + ("EMAIL_PROVIDER", "COOKIE_SECURE")


def generate_role_password() -> str:
    """A database password that survives being written into a URL.

    token_hex, deliberately not token_urlsafe or base64: DATABASE_URL is
    built by interpolation with no percent-encoding, and validate_role_passwords
    refuses / @ : ? # % for reasons written out over URL_RESERVED_IN_PASSWORD.
    Hex can produce none of them. 32 bytes of entropy either way.
    """
    return token_hex(32)


def generate_master_key() -> str:
    """32 random bytes, base64-encoded -- what validate_master_key demands.

    The app decodes this and uses the 32 bytes as an AES key. A hex string
    of the same length decodes to 48 bytes and is rejected; anything shorter
    weakens every encrypted row in app_settings.
    """
    return base64.b64encode(token_bytes(32)).decode()


DEFAULT_GENERATORS = {
    "DB_PASS": generate_role_password,
    "APP_PASS": generate_role_password,
    "CRYPTO_MASTER_KEY": generate_master_key,
}


def assemble_env(installed: dict, operator: dict, generators: dict = None) -> tuple:
    """The environment to deploy, and the list of keys generated just now.

    Read this function as one rule: WHAT IS ALREADY ON THE BOX IS KEPT.
    `installed` is /opt/dsr/server/.env as it stands, and every value in it
    survives into the result untouched. Only a key that is genuinely absent
    -- or present and empty, which the API cannot use either -- is generated.

    CRYPTO_MASTER_KEY is the one that makes this the most dangerous function
    in the file. Every secret row in app_settings is encrypted with it, and
    it is the only copy: generate a second one on a redeploy and every one of
    those rows is unreadable from that moment on, permanently, with no error
    at the time and no way back. So it is generated exactly once, on the
    deployment that finds no .env, and thereafter it is read and written
    back unchanged. Nothing in here may become "regenerate if it looks
    wrong" -- a key that fails validate_master_key is a refusal, not a
    reason to replace it.

    The operator's file supplies the mail credentials and nothing else. It
    cannot introduce a CRYPTO_MASTER_KEY over an installed one; that is not
    a decision a file should be able to make silently, and the fingerprint
    guard exists for the case where someone tries.
    """
    if generators is None:
        generators = DEFAULT_GENERATORS
    env = dict(installed or {})
    for key in OPERATOR_KEYS:
        value = ((operator or {}).get(key) or "").strip()
        if value:
            env[key] = value
    generated = []
    for key in GENERATED_KEYS:
        if (env.get(key) or "").strip():
            continue
        env[key] = generators[key]()
        generated.append(key)
    return env, generated


SECRETS_TEMPLATE = """\
# DSR portal -- the credentials this deployment cannot generate for itself.
#
# Fill in the four values below, save the file, and run the deployer again:
#
#     sudo python3 deploy/dsr_deploy.py
#
# Everything else the portal needs -- the two database passwords and the
# encryption key for saved settings -- is generated on the first deployment
# and reused on every one after it. You never see them and never type them.
#
# These four come from the Microsoft Entra app registration that lets the
# portal send mail as the privacy mailbox. Get them from whoever owns that
# registration:
#
#   PRIVACY_MAILBOX      the mailbox the portal sends from, e.g.
#                        privacy@example.com
#   GRAPH_TENANT_ID      the directory (tenant) ID, a UUID
#   GRAPH_CLIENT_ID      the application (client) ID, a UUID
#   GRAPH_CLIENT_SECRET  the client secret VALUE (not its ID), which Entra
#                        shows once, when it is created
#
# Values may be quoted or bare. Do not commit this file: it is ignored by
# git and should stay mode 600.

PRIVACY_MAILBOX=
GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=

# Optional, and safe to leave alone.
# EMAIL_PROVIDER=graph      # `console` prints mail instead of sending it
# COOKIE_SECURE=true        # false only on a box with no TLS at all
"""


def missing_graph_keys(env: dict) -> list:
    """Which of the four mail credentials are absent or empty."""
    return [key for key in GRAPH_KEYS if not ((env or {}).get(key) or "").strip()]


ADMIN_EMAIL = "admin@dsr.local"
ADMIN_NAME = "Administrator"

# Does an administrator already exist? Asked of the database rather than
# tracked in a file, so a redeploy onto a box that already has one does not
# mint a second and does not print a password that will not work.
ADMIN_EXISTS_COMMAND = (
    "cd / && sudo -u postgres psql -d dsr -tAc \"SELECT 1 FROM users WHERE role IN "
    "('admin', 'super_admin') LIMIT 1\" 2>&1"
)


def admin_password() -> str:
    """A first administrator password: strong, and typeable off a screen.

    token_urlsafe rather than token_hex because somebody reads this one out
    of a terminal and types it into a browser. Its alphabet is A-Za-z0-9-_,
    which is safe inside the single quotes the create-user command wraps it
    in and needs no shell escaping.
    """
    return secrets_module.token_urlsafe(12)


def create_admin_command(password: str) -> str:
    """Create the first administrator through the repo's own script.

    scripts/create-user.mjs already hashes with argon2id and writes the row
    the API expects; reimplementing that here would be a second definition of
    what a user is, free to drift from the one the portal uses.
    """
    return (
        "cd %s/server && set -a && . ./.env && set +a && "
        "node scripts/create-user.mjs '%s' '%s' admin '' '%s'"
        % (INSTALL_PREFIX, ADMIN_EMAIL, ADMIN_NAME, password)
    )


def portal_url() -> str:
    """Where to point a browser. The hostname the box knows itself by, since
    nothing here can know the name it is reached under from outside."""
    try:
        host = socket.gethostname() or "localhost"
    except OSError:
        host = "localhost"
    return "http://%s/admin" % host


def admin_credentials_banner(email: str, password: str, url: str) -> str:
    """Printed once, because this is the only time the password is readable.

    It is argon2-hashed on the way into the database, so nothing can recover
    it afterwards -- if it scrolls past, the way back in is --reset-admin,
    not a lookup.
    """
    nl = chr(10)
    line = "=" * 66
    return nl.join([
        "",
        line,
        "  Sign in to the admin console",
        line,
        "",
        "    Address   %s" % url,
        "    Email     %s" % email,
        "    Password  %s" % password,
        "",
        "  Written down nowhere else. The database holds only an argon2 hash,",
        "  so this cannot be recovered -- if it scrolls away, run:",
        "",
        "      sudo python3 deploy/dsr_deploy.py --reset-admin",
        "",
        line,
        "",
    ]) + nl


def graph_credentials_deferred(path, missing: list, written: bool) -> str:
    """What to print when deploying with the mailer switched off.

    Deliberately not a refusal. Seeing the portal answer on its own address
    is what tells an operator the box is right, and that is worth having
    before they go and find a client secret. So the deployment continues
    under EMAIL_PROVIDER=console -- a value the API boots on -- and says
    plainly which half of the portal is not working yet.
    """
    out = [
        "",
        "-" * 66,
        "  Mail is not configured -- deploying without it",
        "-" * 66,
        "",
        "  Still empty in %s:" % path,
        "",
    ]
    out += ["      %s" % key for key in missing]
    out += [
        "",
        "  The portal, the admin console and signing in will all work.",
        "  Outbound email will not be sent, so a data subject cannot finish",
        "  the email-verification step of the public form.",
        "",
    ]
    if written:
        out.append("  A template has been written to %s." % path)
    out += [
        "  Fill those values in and run this script again to switch mail on.",
        "  Nothing else about the deployment changes.",
        "",
    ]
    nl = chr(10)
    return nl.join(out) + nl


def graph_credentials_refusal(path, missing: list, written: bool) -> str:
    """What to print when the mail credentials are not there yet.

    Not a prompt. A client secret typed at a terminal is echoed, lands in
    the scrollback and, for anyone who pastes rather than types, in the
    shell history -- and this runs under sudo, where that history is root's.
    A file the operator fills in with an editor has none of those problems
    and can be reviewed before it is used.
    """
    lines = []
    if written:
        lines.append("Created %s" % path)
    else:
        lines.append("%s is missing the mail credentials." % path)
    lines.append("")
    lines.append("Fill in these four values, then run this command again:")
    for key in missing:
        lines.append("    %s" % key)
    lines.append("")
    lines.append("They come from the Entra app registration that lets the portal")
    lines.append("send mail as the privacy mailbox. The file explains each one.")
    lines.append("")
    lines.append("    sudo nano %s" % path)
    lines.append("    sudo python3 deploy/dsr_deploy.py")
    return "\n".join(lines) + "\n"


def write_secrets_template(path) -> bool:
    """Write the template, unless something is already there.

    False when the file exists -- never overwrite it. The one file on the
    box holding a credential an operator typed is not a file this tool gets
    to replace with a blank form.
    """
    candidate = pathlib.Path(path)
    if candidate.exists():
        return False
    candidate.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(str(candidate), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(handle, "w") as stream:
        stream.write(SECRETS_TEMPLATE)
    return True


# ---------------------------------------------------------------------------
# The log of a run
# ---------------------------------------------------------------------------

LOG_DIR = "/var/log/dsr-deploy"
LOG_PREFIX = "deploy-"
LOG_SUFFIX = ".log"
# Ten runs. The box has ~10 GB and is mostly full; a log directory that grows
# without limit is one more thing competing with the uploads that cannot be
# deleted.
LOG_KEEP = 10


def log_filename(now=None) -> str:
    """deploy-YYYYmmdd-HHMMSS.log -- named so that sorting is chronological."""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    return "%s%s%s" % (LOG_PREFIX, stamp, LOG_SUFFIX)


def logs_to_delete(names, keep: int = LOG_KEEP) -> list:
    """Which log files to remove so that `keep` remain. Oldest first.

    Sorted by name, which the timestamp format makes the same as sorted by
    age -- and unlike mtime it cannot be reordered by something touching a
    file. Anything not named like one of our logs is never returned: this
    list is fed to unlink.
    """
    ours = sorted(
        n for n in names if n.startswith(LOG_PREFIX) and n.endswith(LOG_SUFFIX)
    )
    if keep <= 0:
        return ours
    return ours[:-keep] if len(ours) > keep else []


def sanitise_log_text(text: str, values) -> str:
    """Everything written to the log goes through here first.

    The log exists to be sent to someone for help, which makes it the single
    most likely place for a generated password to escape. Both filters run:
    redact_url catches a connection string nobody staged locally (one already
    in a .env, echoed back by node), and scrub catches the exact values this
    run generated wherever they appear -- in a psql `LINE 3:` echo, in a
    shell trace, in a heredoc this file wrote.
    """
    return scrub(redact_url(text or ""), values)


class RunLog:
    """The full detail of one run, on disk, with the secrets taken out.

    The terminal gets a summary; this gets each step's command, exit code,
    stdout and stderr. Every write goes through sanitise_log_text -- there is
    deliberately no method that writes anything raw, because the one that
    exists is the one that eventually gets called by mistake.
    """

    def __init__(self, path, values=()):
        self.path = str(path)
        self.values = list(values)
        self.handle = None

    def open(self):
        directory = pathlib.Path(self.path).parent
        directory.mkdir(parents=True, exist_ok=True)
        handle = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self.handle = os.fdopen(handle, "a")
        return self

    def add_values(self, values) -> None:
        """Register secrets generated after the log was opened.

        Called the moment they exist and before any step can print one.
        """
        for value in values:
            if value and value not in self.values:
                self.values.append(value)

    def write(self, text: str) -> None:
        if self.handle is None:
            return
        self.handle.write(sanitise_log_text(text, self.values))
        self.handle.flush()

    def line(self, text: str = "") -> None:
        self.write(text + "\n")

    def step(self, name: str, command: str, returncode, stdout: str, stderr: str) -> None:
        self.line("")
        self.line("--- %s" % name)
        self.line("$ %s" % command)
        self.line("exit %s" % returncode)
        if (stdout or "").strip():
            self.line("stdout:")
            self.line(stdout.rstrip("\n"))
        if (stderr or "").strip():
            self.line("stderr:")
            self.line(stderr.rstrip("\n"))

    def close(self) -> None:
        if self.handle is not None:
            self.handle.close()
            self.handle = None

    def prune(self, keep: int = LOG_KEEP) -> list:
        directory = pathlib.Path(self.path).parent
        try:
            names = [p.name for p in directory.iterdir() if p.is_file()]
        except OSError:
            return []
        removed = []
        for name in logs_to_delete(names, keep):
            try:
                (directory / name).unlink()
                removed.append(name)
            except OSError:
                pass
        return removed


class NullLog:
    """A log that goes nowhere -- for --dry-run and for the tests."""

    path = ""

    def add_values(self, values):
        pass

    def write(self, text):
        pass

    def line(self, text=""):
        pass

    def step(self, name, command, returncode, stdout, stderr):
        pass

    def close(self):
        pass

    def prune(self, keep=LOG_KEEP):
        return []


# ---------------------------------------------------------------------------
# What the operator sees
# ---------------------------------------------------------------------------

def _use_colour(stream) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):
        return False


def _supports(text: str, stream) -> bool:
    """Whether `stream` can encode `text` -- a tick is not universal."""
    encoding = getattr(stream, "encoding", None) or "ascii"
    try:
        text.encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return False
    return True


TICK = "\u2713"
CROSS = "\u2717"
WARN_SIGN = "\u26a0"
ARROW = "\u2192"


def _symbol(preferred: str, fallback: str, stream) -> str:
    return preferred if _supports(preferred, stream) else fallback


def _colour(code: str, text: str, stream) -> str:
    return "\033[%sm%s\033[0m" % (code, text) if _use_colour(stream) else text


def banner(message: str, out=None) -> None:
    out = out or sys.stdout
    line = "-" * 66
    out.write("\n%s\n" % _colour("1;36", line, out))
    out.write("%s\n" % _colour("1;36", "  " + message, out))
    out.write("%s\n" % _colour("1;36", line, out))
    out.flush()


def step(number: int, total: int, message: str, out=None) -> None:
    """The numbered heading a failure is read against.

    Numbered because the first question after a failed deployment is "how
    far did it get", and an operator who can answer "it stopped at 6 of 10,
    building the bundles" has already narrowed it to one thing.
    """
    out = out or sys.stdout
    out.write("\n%s\n" % _colour("1", "[%d/%d] %s" % (number, total, message), out))
    out.flush()


def ok(message: str, out=None) -> None:
    out = out or sys.stdout
    out.write("  %s  %s\n" % (_colour("0;32", _symbol(TICK, "OK", out), out), message))
    out.flush()


def warn(message: str, out=None) -> None:
    out = out or sys.stdout
    out.write("  %s  %s\n" % (_colour("1;33", _symbol(WARN_SIGN, "!", out), out), message))
    out.flush()


def info(message: str, out=None) -> None:
    out = out or sys.stdout
    out.write("  %s  %s\n" % (_colour("0;36", _symbol(ARROW, "-", out), out), message))
    out.flush()


def fail(message: str, err=None) -> None:
    err = err or sys.stderr
    err.write("  %s  %s\n" % (_colour("0;31", _symbol(CROSS, "x", err), err), message))
    err.flush()


def die(message: str, code: int = 1) -> None:
    fail(message)
    sys.exit(code)


# ---------------------------------------------------------------------------
# The command line: three flags, no subcommands
# ---------------------------------------------------------------------------

USAGE = """\
Deploy the DSR portal on this RHEL 9 host.

    sudo python3 deploy/dsr_deploy.py              provision, deploy, verify
    sudo python3 deploy/dsr_deploy.py --diagnose   check only; change nothing
    sudo python3 deploy/dsr_deploy.py --dry-run    print the plan; touch nothing
    sudo python3 deploy/dsr_deploy.py --skip-build reuse the existing dist/
    sudo python3 deploy/dsr_deploy.py --reset-admin  new admin password

With --diagnose, a group flag narrows the report: %s.
"""


class Options(object):
    """The flags, as attributes. Membership tests over sys.argv, no argparse.

    Unknown flags are collected rather than ignored: `--dryrun` silently
    doing a real deployment is the failure mode this exists to prevent.
    """

    NAMES = (
        "diagnose", "dry_run", "skip_build", "no_state", "reset_admin", "help",
    ) + DOCTOR_GROUPS

    def __init__(self, argv=()):
        for name in self.NAMES:
            setattr(self, name, False)
        self.unknown = []
        for argument in argv:
            name = argument.lstrip("-").replace("-", "_")
            if argument in ("-h", "--help"):
                self.help = True
            elif argument.startswith("--") and name in self.NAMES:
                setattr(self, name, True)
            else:
                self.unknown.append(argument)


def parse_flags(argv) -> Options:
    return Options(argv)


def unknown_flag_refusal(unknown: list) -> str:
    """"" when every argument was understood; the refusal otherwise."""
    if not unknown:
        return ""
    return (
        "FATAL: not a flag this tool has: %s\n\n%s"
        % (" ".join(unknown), USAGE % ", ".join("--" + g for g in DOCTOR_GROUPS))
    )


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

def check_root() -> None:
    """Refuse anywhere this cannot possibly work, before it half works."""
    geteuid = getattr(os, "geteuid", None)
    if geteuid is None or geteuid() != 0:
        raise Refusal(
            "FATAL: this has to run as root on the server itself.\n"
            "\n"
            "    sudo python3 deploy/dsr_deploy.py\n"
        )


def rhel_warning(os_release: str) -> str:
    """"" when this looks like RHEL 9; a warning otherwise. Never a refusal.

    CentOS Stream 9, Alma and Rocky are all fine targets and none of them
    says "Red Hat" -- `platform:el9` is what the packages actually care
    about, so that is what is checked and everything else is a warning an
    operator can read and overrule by carrying on.
    """
    text = os_release or ""
    if "platform:el9" in text:
        return ""
    if not text.strip():
        return "could not read /etc/os-release; assuming this is RHEL 9"
    return (
        "this does not look like RHEL 9 (no platform:el9 in /etc/os-release). "
        "The package names, /var/lib/pgsql and the SELinux settings below are "
        "RHEL 9's; continuing anyway"
    )


def missing_repo_paths(root: str) -> list:
    """The files a deployment reads out of the checkout. [] when complete."""
    needed = [
        os.path.join(root, "server", "package.json"),
        os.path.join(root, "apps", "admin", "package.json"),
        os.path.join(root, "apps", "public-form", "package.json"),
        os.path.join(root, "form-schema"),
        str(NGINX_CONF_LOCAL),
        str(UNIT_FILE_LOCAL),
    ]
    return [p for p in needed if not os.path.exists(p)]


def repo_refusal(root: str, missing: list) -> str:
    if not missing:
        return ""
    lines = [
        "FATAL: this does not look like a complete DSR checkout.",
        "       Run it from the repository you cloned onto this box:",
        "",
        "           cd /path/to/dsr-portal",
        "           sudo python3 deploy/dsr_deploy.py",
        "",
        "       Looked under %s and did not find:" % root,
    ]
    for path in missing:
        lines.append("           %s" % path)
    return "\n".join(lines)


def built_bundles_missing(root: str) -> list:
    """Which built directories --skip-build would have nothing to install."""
    return [
        item.local
        for item in deploy_payload(root)
        if item.kind == "dir"
        and item.local.endswith("dist")
        and not os.path.isdir(item.local)
    ]


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

TOTAL_STEPS = 10


class NullOut(object):
    """Swallows the running commentary that has its own line already.

    copy_self and poll_health both narrate; here their narration is
    replaced by one ok() line each, and the detail is in the log.
    """

    def __init__(self, out=None):
        self.out = out

    def write(self, text):
        return len(text)

    def flush(self):
        pass



def print_diagnosis(runner, out, log, now_epoch=None) -> list:
    """Run every check and print what it found. Never raises.

    Called after a failed step and after a health-poll timeout as well as at
    the end of a good run: an exit code tells an operator that something is
    wrong, and this tells them what. It changes nothing, so running it on
    the way out of a failure costs only the seconds it takes.
    """
    if now_epoch is None:
        now_epoch = int(time.time())
    try:
        capture = collect(runner)
        findings = assemble_findings(capture, {}, now_epoch)
    except Exception as exc:  # pragma: no cover - a broken collector is not fatal
        out.write("could not run the checks: %s\n" % exc)
        return []
    report = render_findings(findings)
    out.write(report)
    log.write(report)
    return findings


def survey_host(target, out, log) -> str:
    """Print what else is on this box, and how to turn each of it off."""
    listeners = parse_listeners(target.run(LISTENERS_COMMAND, check=False).stdout)
    units = parse_pid_units(target.run(PID_UNITS_COMMAND, check=False).stdout)
    report = takeover_report(listeners, units)
    if not report:
        ok("nothing else is listening on a TCP port", out)
        log.line("no other TCP listeners")
        return ""
    warn("this box is running something else:", out)
    out.write("\n" + report + "\n")
    log.line(report)
    return report


def run_deployment(options, out=None, err=None, target=None, log=None,
                   runner=None) -> int:
    """The whole thing, in ten numbered steps.

    The order is the argument: provision before build (the build needs the
    Node this installs), guards before anything is mirrored (mirroring
    removes its destination), migrate before restart, and the checks last,
    where they verify rather than predict.
    """
    out = out or sys.stdout
    err = err or sys.stderr
    target = target or LocalTarget()
    runner = runner or LocalRunner()
    root = str(_DEPLOY_DIR.parent)

    banner("DSR portal deployment", out)

    if options.dry_run:
        out.write(
            "Nothing below is run. This is what a deployment would do.\n"
        )
        out.write("\nProvisioning:\n")
        out.write(render_plan(provision_steps()))
        out.write("\nDeployment:\n")
        out.write(render_plan(deploy_steps({})))
        out.write("\nThen: health check, then the checks --diagnose runs.\n")
        return 0

    # -- 1 ------------------------------------------------------------------
    step(1, TOTAL_STEPS, "Preflight", out)
    check_root()
    ok("running as root", out)

    if log is None:
        try:
            log = RunLog(os.path.join(LOG_DIR, log_filename())).open()
        except OSError as exc:
            # A read-only or full /var/log is a reason to lose the log, not
            # a reason to refuse the deployment the operator asked for.
            log = NullLog()
            warn("could not open a log under %s (%s); continuing without one"
                 % (LOG_DIR, exc.strerror or exc), out)
    log.line("dsr_deploy.py starting on %s" % this_host())
    if log.path:
        ok("logging this run to %s" % log.path, out)
    removed = log.prune()
    if removed:
        info("removed %d older log%s" % (len(removed), "" if len(removed) == 1 else "s"), out)

    warning = rhel_warning(target.run("cat /etc/os-release", check=False).stdout)
    if warning:
        warn(warning, out)
        log.line("WARNING: %s" % warning)
    else:
        ok("RHEL 9 (platform:el9)", out)

    missing = missing_repo_paths(root)
    refusal = repo_refusal(root, missing)
    if refusal:
        raise Refusal(refusal)
    ok("checkout looks complete: %s" % root, out)

    copy_self(target, NullOut(out))
    ok("this tool copied to %s (the config rewrites run it)" % REMOTE_SELF, out)

    # -- 2 ------------------------------------------------------------------
    step(2, TOTAL_STEPS, "What else is on this box", out)
    survey_host(target, out, log)

    # -- 3 ------------------------------------------------------------------
    step(3, TOTAL_STEPS, "Secrets", out)
    installed = read_existing_env()
    if installed:
        ok("read the existing %s (%d values kept)" % (ENV_PATH, len(installed)), out)
    else:
        info("no %s yet -- this is a first deployment" % ENV_PATH, out)

    path = secrets_path()
    operator = read_operator_secrets(path)
    absent = missing_graph_keys(operator)
    if absent:
        # Deploy anyway, with the mailer switched off rather than the run
        # stopped. The portal, the admin console and sign-in all work without
        # Graph credentials -- only outbound mail does not -- so a first run
        # can prove the box is serving before anyone goes hunting for a client
        # secret. EMAIL_PROVIDER=console is a value the API boots on, so it
        # starts cleanly instead of crash-looping the way blank Graph keys
        # would. Filling the four values in and re-running turns mail on;
        # nothing else about the deployment changes.
        written = write_secrets_template(path)
        operator["EMAIL_PROVIDER"] = "console"
        out.write(graph_credentials_deferred(path, absent, written))
        log.line("continuing without mail: %s still needs %s"
                 % (path, " ".join(absent)))
    else:
        # The script set console itself on an earlier run, so it has to unset
        # it here. assemble_env keeps whatever is already installed, and
        # .secrets.env ships with EMAIL_PROVIDER commented out -- so without
        # this, filling in all four Graph values and redeploying leaves mail
        # off, with only the warning the operator has already learned to
        # ignore. An EMAIL_PROVIDER the operator set explicitly still wins.
        if not (operator.get("EMAIL_PROVIDER") or "").strip():
            operator["EMAIL_PROVIDER"] = "graph"
        ok("mail credentials read from %s" % path, out)

    secrets, generated = assemble_env(installed, operator)
    log.add_values([secrets.get(key, "") for key in GENERATED_KEYS])
    for key in GENERATED_KEYS:
        if key in generated:
            ok("generated %s" % key, out)
        else:
            ok("kept the existing %s" % key, out)
    if "CRYPTO_MASTER_KEY" not in generated:
        info(
            "the encryption key is the one already installed (%s) -- a new one "
            "would orphan every saved setting"
            % key_fingerprint(secrets.get("CRYPTO_MASTER_KEY", "")),
            out,
        )

    # The belt to the braces above: whatever route the value took through
    # assemble_env, the key about to be written must be the key that is
    # already there. If those two ever disagree, stop before the .env is
    # written rather than after.
    refusal = fingerprint_refusal(
        key_fingerprint_or_blank(secrets.get("CRYPTO_MASTER_KEY", "")),
        key_fingerprint_or_blank(installed.get("CRYPTO_MASTER_KEY", "")),
        str(path),
        this_host(),
    )
    if refusal:
        raise Refusal(refusal)

    for warning in validate_secrets(secrets):
        warn(warning, out)
        log.line("WARNING: %s" % warning)

    # -- 4 ------------------------------------------------------------------
    step(4, TOTAL_STEPS, "Disk space for provisioning", out)
    check_disk_budget(
        target,
        provision_needs(),
        "nginx, Node 22, PostgreSQL 16, SELinux tooling and the dnf cache",
    )
    ok("enough room for the packages", out)

    # -- 5 ------------------------------------------------------------------
    # From here to the end, the staged secrets file and its removal bracket
    # everything: the role step reads DB_PASS out of it and the .env step
    # reads all nine, and a run that dies in between must not leave a file
    # holding both database passwords behind on disk.
    #
    # Two writes rather than one. Provisioning needs the two role passwords
    # and nothing else, so that is all it gets: the encryption key is not
    # exposed for the length of an npm build it has no part in.
    try:
        step(5, TOTAL_STEPS, "Provision the host", out)
        target.write(
            REMOTE_SECRETS,
            remote_secrets_content(secrets, PROVISION_SECRET_KEYS),
            mode="600",
        )
        _run_phase(target, provision_steps(), secrets, out, err, log, runner)

        # -- 6 --------------------------------------------------------------
        step(6, TOTAL_STEPS, "Build the bundles", out)
        if options.skip_build:
            unbuilt = built_bundles_missing(root)
            if unbuilt:
                raise Refusal(
                    "FATAL: --skip-build, but there is nothing built to install:\n"
                    "       %s\n"
                    "       Run again without --skip-build." % "\n       ".join(unbuilt)
                )
            info("--skip-build: reusing what is already in dist/", out)
        else:
            for directory, command in build_commands(root):
                info("%s: %s" % (directory, command), out)
                result = subprocess.run(
                    command, cwd=directory, shell=True, capture_output=True, text=True
                )
                log.step("build %s" % directory, command, result.returncode,
                         result.stdout, result.stderr)
                if result.returncode != 0:
                    err.write(sanitise_log_text(result.stderr or result.stdout or "",
                                                secrets.values()))
                    raise Refusal(
                        "FATAL: `%s` failed in %s (exit %d). Nothing was installed."
                        % (command, directory, result.returncode)
                    )
            ok("all three bundles built", out)

        # -- 7 --------------------------------------------------------------
        step(7, TOTAL_STEPS, "Disk space for the deployment", out)
        check_disk_budget(target, deploy_needs(), deploy_breakdown())
        ok("enough room for %s" % deploy_breakdown(), out)

        # -- 8 --------------------------------------------------------------
        step(8, TOTAL_STEPS, "Install the bundles", out)
        for item in deploy_payload(root):
            if item.kind == "dir":
                target.copy_dir(item.local, item.remote)
            else:
                target.copy_file(item.local, item.remote)
            log.line("installed %s -> %s" % (item.local, item.remote))
        ok("%d paths installed" % len(deploy_payload(root)), out)

        # -- 9 --------------------------------------------------------------
        step(9, TOTAL_STEPS, "Deploy", out)
        admin_banner = ""
        target.write(
            REMOTE_SECRETS,
            remote_secrets_content(secrets, DEPLOY_SECRET_KEYS),
            mode="600",
        )
        _run_phase(target, deploy_steps(secrets), secrets, out, err, log, runner)

        # An administrator, if the box does not have one. Without this the
        # deployment finishes with a portal nobody can sign in to, which is
        # how the first real run ended.
        existing = target.run(ADMIN_EXISTS_COMMAND, check=False).stdout.strip()
        if existing == "1":
            info("an administrator already exists -- use --reset-admin for a "
                 "new password", out)
        elif _unreadable(existing) or "psql" in existing.lower():
            warn("could not tell whether an administrator exists: %s"
                 % existing.splitlines()[0][:80], out)
        else:
            password = admin_password()
            log.add_values([password])
            result = target.run(create_admin_command(password), check=False)
            log.step("create administrator", "node scripts/create-user.mjs "
                     "(password withheld)", result.returncode,
                     result.stdout, result.stderr)
            if result.returncode == 0:
                ok("created the first administrator", out)
                admin_banner = admin_credentials_banner(
                    ADMIN_EMAIL, password, portal_url())
            else:
                fail("could not create an administrator: %s"
                     % sanitise_log_text(result.stderr, [password]).strip()[:200], err)

        # -- 10 -------------------------------------------------------------
        step(10, TOTAL_STEPS, "Health check and verification", out)
        if not poll_health(target, NullOut(out)):
            fail(
                "the API did not answer within %ds."
                % (HEALTH_ATTEMPTS * HEALTH_INTERVAL_SECONDS),
                err,
            )
            journal = sanitise_log_text(
                target.run(JOURNAL_TAIL_COMMAND, check=False).stdout,
                secrets.values(),
            )
            err.write(journal)
            log.line("health poll timed out; journal follows")
            log.write(journal)
            out.write("\nWhat the checks say about this box:\n")
            print_diagnosis(runner, out, log)
            return 1
        ok("the API is up and answering on 127.0.0.1:%d" % APP_PORT, out)

    finally:
        target.run("rm -f %s" % REMOTE_SECRETS, check=False)

    out.write("\nVerifying:\n")
    findings = print_diagnosis(runner, out, log)
    worst = exit_code_for(findings)
    log.line("finished with worst finding severity %d" % worst)
    log.close()
    if worst >= 2:
        fail("deployed, but the checks above found failures.", err)
        if admin_banner:
            out.write(admin_banner)
        return 1
    banner("DEPLOY_OK", out)
    # Last thing on the screen on purpose. It is the only time this password
    # is readable, and a deployment prints a lot of lines after it otherwise.
    if admin_banner:
        out.write(admin_banner)
    return 0


def _run_phase(target, steps, secrets, out, err, log, runner) -> None:
    """Run one list of steps, naming each, diagnosing the one that fails."""
    total = len(steps)
    for index, entry in enumerate(steps, 1):
        info("[%d/%d] %s" % (index, total, entry.name), out)
        result = target.run(entry.command, check=False)
        log.step(entry.name, entry.command, result.returncode,
                 result.stdout, result.stderr)
        if result.returncode != 0:
            message = sanitise_log_text(
                step_failure_message(
                    entry.name, result.returncode, result.stderr, result.stdout
                ),
                secrets.values(),
            )
            fail("step %d of %d failed." % (index, total), err)
            err.write(message + "\n")
            out.write("\nWhat the checks say about this box:\n")
            print_diagnosis(runner, out, log)
            log.line("FAILED at step %d of %d" % (index, total))
            log.close()
            raise Refusal(
                "%s\n\nThe full log of this run is at %s" % (message, log.path)
            )


def cmd_reset_admin(out=None) -> int:
    """A fresh administrator password, printed once.

    The deployment prints one the first time it creates an administrator, and
    argon2 means nothing can read it back afterwards. This is the way in once
    that line has scrolled away -- create-user.mjs upserts, so running it
    against the existing address resets rather than duplicating.
    """
    if out is None:
        out = sys.stdout
    if os.geteuid() != 0:
        sys.stderr.write("FATAL: run this with sudo." + chr(10))
        return 2
    target = LocalTarget()
    password = admin_password()
    result = target.run(create_admin_command(password), check=False)
    if result.returncode != 0:
        sys.stderr.write(
            "FATAL: could not reset the administrator: %s" + chr(10)
            % sanitise_log_text(result.stderr, [password]).strip()[:300]
        )
        return 1
    out.write(admin_credentials_banner(ADMIN_EMAIL, password, portal_url()))
    return 0


def cmd_diagnose(options, out=None) -> int:
    """The checks, and nothing else. Changes nothing on the box."""
    out = out or sys.stdout
    banner("DSR portal checks", out)
    return cmd_doctor(options, LocalRunner())


def main(argv: list) -> int:
    if sys.version_info < MIN_PYTHON:
        sys.stderr.write(
            "This tool needs Python %d.%d or newer; found %s\n"
            % (MIN_PYTHON[0], MIN_PYTHON[1], sys.version.split()[0])
        )
        return 2

    options = parse_flags(argv)
    refusal = unknown_flag_refusal(options.unknown)
    if refusal:
        sys.stderr.write(refusal + "\n")
        return 2
    if options.help:
        sys.stdout.write(USAGE % ", ".join("--" + g for g in DOCTOR_GROUPS))
        return 0

    try:
        if options.diagnose:
            return cmd_diagnose(options)
        if options.reset_admin:
            return cmd_reset_admin()
        return run_deployment(options)
    except Refusal as exc:
        # Refusals already read as the operator-facing message they are;
        # anything else is a bug and should keep its traceback.
        sys.stderr.write("%s\n" % exc)
        return 1
    except RuntimeError as exc:
        sys.stderr.write("FATAL: %s\n" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
