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
import base64
import binascii
import calendar
import collections
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

INSTALL_PREFIX = "/opt/dsr"
WEB_ROOT = "/var/www/dsr"
UPLOADS_DIR = "/opt/dsr/uploads"
ENV_PATH = "/opt/dsr/server/.env"
# /root rather than the install prefix: provision runs against a bare host
# where /opt/dsr and the dsr user do not exist yet, and .target.env already
# assumes a root@host ssh target.
REMOTE_SELF = "/root/dsr_deploy.py"
# Where the secret values a step needs are staged on the box, mode 0600 and
# deleted when the run ends. A file rather than a `DB_PASS=... command`
# prefix because the second form puts the password in the box's process
# table for anyone with `ps` to read.
REMOTE_SECRETS = "/root/.dsr-secrets.env"
STATE_PATH = "/var/lib/dsr-deploy/state.json"
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


def load_target(text: str) -> dict:
    """Parse deploy/.target.env. DEPLOY_HOST is accepted as an alias for HOST,
    matching what deploy.sh already does (`HOST="${HOST:-${DEPLOY_HOST:-}}"`).
    """
    env = parse_env_text(text)
    if "HOST" not in env and "DEPLOY_HOST" in env:
        env["HOST"] = env["DEPLOY_HOST"]
    return env


class Ssh:
    """Runs a command on the target over ssh, or copies a file/directory to it.

    The remote command is always a single argv element, never spliced into a
    local shell string. That is the whole reason this tool copies itself to
    the box: reading a file in Python beats a sed expression nested inside
    three levels of shell quoting, and it means a command containing quotes,
    semicolons or `$(...)` travels intact instead of being re-parsed twice.
    """

    def __init__(self, target: str, key: str):
        self.target = target
        self.key = key

    def argv(self, command: str) -> list:
        return ["ssh", "-o", "StrictHostKeyChecking=no", "-i", self.key, self.target, command]

    def run(self, command: str, check: bool = True):
        result = subprocess.run(self.argv(command), capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(
                "ssh command failed (exit %d): %s\n%s"
                % (result.returncode, command, result.stderr)
            )
        return result

    def push_file(self, local: str, remote: str) -> None:
        """`cat > remote` fed from local's bytes -- matches deploy.sh's push_file."""
        with open(local, "rb") as fh:
            result = subprocess.run(
                self.argv("cat > '%s'" % remote), stdin=fh, capture_output=True
            )
        if result.returncode != 0:
            raise RuntimeError(
                "push_file failed for %s: %s"
                % (remote, result.stderr.decode(errors="replace"))
            )

    def push_text(self, text: str, remote: str, mode: str = "") -> None:
        """Write text to a remote path, fed over stdin.

        The bytes travel on the pipe, never in the command. That matters
        for REMOTE_SECRETS: a heredoc carrying a password would put it in
        the argv of the remote shell, where `ps` on the box can read it for
        as long as the connection lasts.
        """
        command = "cat > '%s'" % remote
        if mode:
            command = "umask 077 && %s && chmod %s '%s'" % (command, mode, remote)
        result = subprocess.run(
            self.argv(command), input=text.encode(), capture_output=True
        )
        if result.returncode != 0:
            raise RuntimeError(
                "push_text failed for %s: %s"
                % (remote, result.stderr.decode(errors="replace"))
            )

    def push_dir(self, local: str, remote: str) -> None:
        """Mirror a directory: `tar -czf - -C local .` piped into a remote
        `rm -rf dest && mkdir -p dest && tar -xzf - -C dest`, exactly what
        deploy.sh does today so it keeps working from Git Bash on Windows.
        """
        tar = subprocess.Popen(["tar", "-czf", "-", "-C", local, "."], stdout=subprocess.PIPE)
        ssh_proc = subprocess.Popen(
            self.argv(
                "rm -rf '%s' && mkdir -p '%s' && tar -xzf - -C '%s'" % (remote, remote, remote)
            ),
            stdin=tar.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if tar.stdout is not None:
            tar.stdout.close()
        _out, err = ssh_proc.communicate()
        tar.wait()
        if tar.returncode != 0:
            raise RuntimeError("tar failed for %s (exit %d)" % (local, tar.returncode))
        if ssh_proc.returncode != 0:
            raise RuntimeError(
                "push_dir failed for %s: %s" % (remote, (err or b"").decode(errors="replace"))
            )


def _cat_heredoc_command(
    remote_path: str, content: str, marker: str = "DSR_EOF", expand: bool = False
) -> str:
    """A `cat > remote_path <<MARKER` fragment carrying file content.

    The delimiter is quoted by default, so the remote shell expands nothing
    inside and the content lands byte-for-byte without a second SSH round
    trip for what push_file would otherwise do.

    `expand=True` unquotes it, which is how the service .env is written:
    the body holds `${DB_PASS}` rather than the password itself, and the
    remote shell substitutes values it read from REMOTE_SECRETS. That is
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
    window -- a dropped SSH connection, an OOM kill on a 1-vCPU box -- the
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
            "dnf install -y curl ca-certificates policycoreutils-python-utils "
            "firewalld nginx && dnf clean all",
        ),
        Step(
            "install Node.js 22",
            # Deliberate `;` after `module reset`: it exits non-zero when no
            # nodejs stream is enabled, which is the common case on a bare
            # box and not a reason to skip the install that follows.
            "(command -v node >/dev/null 2>&1 && [ \"$(node -v | cut -c2-3)\" -ge 22 ]) || "
            "(dnf module reset -y nodejs >/dev/null 2>&1; "
            "dnf module enable -y nodejs:22 && dnf install -y nodejs && dnf clean all)",
        ),
        Step(
            "install PostgreSQL 16",
            # Deliberate `;` after `module reset`, for the same reason as
            # the Node step above.
            "rpm -q postgresql-server >/dev/null 2>&1 || "
            "(dnf module reset -y postgresql >/dev/null 2>&1; "
            "dnf module enable -y postgresql:16 && "
            "dnf install -y postgresql-server postgresql-contrib && dnf clean all)",
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
            + "sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL\n"
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
            "sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'dsr'\" "
            "| grep -q 1 || sudo -u postgres createdb -O dsr -E UTF8 -T template0 dsr\n"
            "sudo -u postgres psql -d dsr -v ON_ERROR_STOP=1 "
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
# straight to ssh -- never spliced into a local shell string first. That
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


def deploy_steps(env: dict) -> list:
    """The deployment sequence, in order.

    Building/syncing the compiled bundles is the operator's runner's job
    (Ssh.push_file / push_dir move bytes; they are not steps here). This is
    everything that happens once those bytes are already on the box.
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
            "install the dsr-api unit and nginx conf.d/dsr.conf",
            # `set -e`: two heredocs joined by a newline means the second
            # one's exit code is the step's, and a unit file that never
            # landed would be reported as installed.
            "set -e\n"
            + _cat_heredoc_command(
                UNIT_REMOTE, shipped_text(UNIT_FILE_LOCAL), "DSR_UNIT_EOF"
            )
            + "\n"
            + _cat_heredoc_command(
                NGINX_SITE_CONF_REMOTE, shipped_text(NGINX_CONF_LOCAL), "DSR_NGINX_EOF"
            ),
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
# decision buried inside a function that opens an SSH connection is a decision
# nobody can test without a server.
# ---------------------------------------------------------------------------

# deploy.sh's default, and its reason: each droplet has its own secrets file
# and writing the wrong one is not a recoverable mistake.
DEFAULT_SECRETS_NAME = ".secrets.blr.env"

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
PROVISION_INSTALL_BYTES = 600 * 1000 * 1000
PROVISION_CACHE_BYTES = 300 * 1000 * 1000
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

# Asks the pushed copy of this tool for the fingerprint of the key already on
# the box. Both sides of the comparison therefore run key_fingerprint over a
# value parse_env_text extracted -- the same function, the same normalisation.
#
# deploy.sh does this with an `md5sum | cut -c1-8` shell one-liner. This tool
# must not: key_fingerprint is sha256, so a shell fingerprint would never
# equal a local one and the guard would refuse every deployment. The only
# reason a sha256 fingerprint is safe here is that the tool computes both
# sides. An empty result means the box has no .env yet, which is a first
# deployment rather than a mismatch, so an absent key prints nothing at all
# instead of the hash of an empty string.
REMOTE_FINGERPRINT_COMMAND = (
    "python3 -c \""
    "import sys; sys.path.insert(0, '%s'); import dsr_deploy as d, pathlib; "
    "p = pathlib.Path('%s'); "
    "k = d.parse_env_text(p.read_text()).get('CRYPTO_MASTER_KEY', '') if p.exists() else ''; "
    "print(d.key_fingerprint(k) if k.strip() else '')\""
) % (REMOTE_SELF.rsplit("/", 1)[0], ENV_PATH)

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


def validate_role_passwords(env: dict) -> None:
    """Raise unless both database role passwords are actually there.

    An absent key is staged as `''` rather than omitted, and the .env body
    references a bare `${DB_PASS}` with no `:?`. So a secrets file missing
    either one produces `postgres://dsr:@127.0.0.1:5432/dsr`, the API fails
    to authenticate, systemd crash-loops it, and nothing upstream said a
    word. Provisioning happens to catch this -- its SQL uses `${DB_PASS:?}`
    -- but deploying did not, and deploying is the command that runs far
    more often.
    """
    missing = [key for key in ROLE_PASSWORD_KEYS if not (env.get(key) or "").strip()]
    if missing:
        raise SecretsError(
            "These database passwords are missing or empty in the secrets "
            "file: %s. The .env would carry an empty password, the API would "
            "fail to authenticate against postgres, and systemd would "
            "crash-loop it." % " ".join(missing)
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


def fingerprint_probe_refusal(returncode: int, stderr: str, host: str) -> str:
    """"" when the fingerprint probe ran; the refusal text when it did not.

    fingerprint_refusal reads an empty remote fingerprint as "this box has
    no .env yet", which is right -- the probe prints nothing and exits 0 on
    a first deployment. But every way the probe can *fail* looks identical
    on stdout: python3 absent, /root/dsr_deploy.py unreadable, an `import
    dsr_deploy` that raises because one 3.10-only construct reached this
    file, a read_text that raises. In all of them the traceback goes to
    stderr and stdout is empty.

    Reading only stdout therefore makes the guard fail open, and the import
    failure is the case that matters: this file must run on RHEL 9's Python
    3.9 while being developed on a newer one, so a single 3.10-only
    construct would keep the unit suite green and --dry-run perfect while
    disarming the guard on every real box -- exactly the hosts it protects.
    Writing the wrong .env there orphans every encrypted row in
    app_settings, and nothing recovers them.

    So the return code decides first, and stdout is only trusted after it.
    """
    if returncode == 0:
        return ""
    lines = [
        "FATAL: could not read the CRYPTO_MASTER_KEY already on %s "
        "(probe exit %d)." % (host, returncode),
        "       Until that is known, deploying could write a .env whose key",
        "       differs from the one app_settings was encrypted with, which",
        "       nothing recovers -- so an unreadable box is a refusal, not a",
        "       first deployment.",
        "       The probe runs %s on the box; check python3 is installed and"
        % REMOTE_SELF,
        "       that file is readable, then run again. It said:",
    ]
    detail = (stderr or "").strip()
    if not detail:
        detail = "(nothing on stderr)"
    for line in detail.splitlines():
        lines.append("       " + line)
    return "\n".join(lines)


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


def build_commands(root: str) -> list:
    """(directory, command) for each bundle built before anything is pushed.

    A string rather than an argv list because on Windows -- where this tool
    is run from Git Bash today -- `npm` is a `.cmd` shim that only a shell
    resolves. Nothing operator-supplied is interpolated into it.
    """
    return [(os.path.join(root, name), "npm run build") for name in BUILD_DIRS]


def deploy_payload(root: str) -> list:
    """Every local path pushed to the box, and where it lands.

    The same set deploy.sh syncs, in the same order. Note what is not here:
    UPLOADS_DIR is never a destination. push_dir mirrors a directory by
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
        detail = "the command printed nothing; try it by hand over ssh"
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

    The password class stops at `/` rather than at `@`, so an `@` inside the
    password -- ordinary, and something node-postgres cannot parse either --
    no longer ends the match early and leaves the tail of the password
    visible. The username class allows the empty string, because
    `postgres://:pw@host` is a legal URL that the earlier form left untouched.
    """
    return re.sub(r"(://[^\s:/]*):[^\s/]*@", r"\1:***@", text or "")


def describe_url(value: str) -> str:
    """`host:port/database` out of a connection string. Never the credentials.

    Nothing here reads userinfo or the query string, so no shape of password
    -- an `@` inside it, an empty username, `?password=` -- can reach a
    Finding through this function. That is the whole point: redaction is a
    filter that can miss, and this is a construction with nothing to miss.
    """
    try:
        parsed = urlsplit(value or "")
        if not parsed.scheme:
            # Without a scheme this is not a URL, and echoing it back would
            # print whatever the env file actually holds -- which, for a
            # malformed value, can be the bare password.
            return "unparseable connection string"
        host = parsed.hostname or "?"
        port = parsed.port or 5432
    except ValueError:
        # A non-numeric port makes .port raise rather than return None.
        return "unparseable connection string"
    database = (parsed.path or "/").lstrip("/") or "?"
    return "%s:%s/%s" % (host, port, database)


# What a collector prints instead of an answer when it could not run at all.
# Folding stderr into stdout is what makes these visible; without it the
# complaint is discarded and the empty result reads as a clean log, which is
# a diagnostic asserting health on the strength of having read nothing.
_UNREADABLE_MARKERS = ("command not found", "Permission denied", "Error opening")


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
    if _unreadable(avc):
        findings.append(
            Finding(
                group,
                WARN,
                "could not read the audit log",
                "ausearch answered with an error rather than with denials, so "
                "the absence of denials here is not evidence that there are "
                "none. auditd may not be installed or running.",
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
            findings.append(
                Finding(group, OK, "%s -> %s" % (key, describe_url(value)), "", "")
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
    "sudo -u postgres psql -tAc \"SELECT pg_database_size('dsr')\" 2>&1"
)

TABLE_SIZES_COMMAND = (
    "sudo -u postgres psql -d dsr -tAc \"SELECT c.relname, "
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
POSTGRES_MINIMUM = "16"


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
        "sudo -u postgres psql -tAc \"SELECT rolname FROM pg_roles WHERE "
        "rolname IN ('dsr', 'dsr_app') ORDER BY rolname\" 2>&1",
    ),
    (
        "migrations",
        "sudo -u postgres psql -d dsr -tAc 'SELECT name FROM "
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
    """Runs collectors on this machine -- what `doctor --remote` uses.

    A collector that fails is not an error. `ausearch -m avc -ts recent`
    exits 1 when there are no denials, which is the good case, and a missing
    binary is itself something an evaluator reports. Whatever the command
    managed to print is the answer.
    """

    def run(self, command: str) -> str:
        try:
            result = subprocess.run(command, shell=True, capture_output=True, text=True)
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


class SshRunner:
    """Runs collectors on the target over ssh; evaluation stays local."""

    def __init__(self, ssh: "Ssh"):
        self.ssh = ssh

    def run(self, command: str) -> str:
        return self.ssh.run(command, check=False).stdout

    def write(self, path: str, text: str) -> None:
        directory = path.rsplit("/", 1)[0]
        self.ssh.run(
            "mkdir -p '%s' && %s"
            % (directory, _cat_heredoc_command(path, text, "DSR_STATE")),
            check=False,
        )


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


TARGET_ENV_LOCAL = _DEPLOY_DIR / ".target.env"


def target_ssh():
    """(Ssh, host) from deploy/.target.env, or a refusal naming the file."""
    if not TARGET_ENV_LOCAL.exists():
        raise SecretsError(
            "No ssh target. Copy deploy/target.example.env to deploy/.target.env "
            "and fill in HOST. (To read a box you are already logged in to, run "
            "`doctor --remote` there; provision and deploy always work over ssh.)"
        )
    target = load_target(TARGET_ENV_LOCAL.read_text())
    host = (target.get("HOST") or "").strip()
    if not host:
        raise SecretsError("deploy/.target.env has no HOST (or DEPLOY_HOST).")
    key = (target.get("SSH_KEY") or "").strip() or os.path.expanduser("~/.ssh/id_ed25519")
    return Ssh(host, os.path.expanduser(key)), host


def doctor_runner(args):
    """Local when already on the box, ssh otherwise. Evaluation is always local."""
    if getattr(args, "remote", False):
        return LocalRunner()
    ssh, _host = target_ssh()
    return SshRunner(ssh)


def secrets_path() -> pathlib.Path:
    """Which secrets file to read. SECRETS_FILE overrides, as deploy.sh."""
    override = (os.environ.get("SECRETS_FILE") or "").strip()
    if override:
        return pathlib.Path(override)
    return _DEPLOY_DIR / DEFAULT_SECRETS_NAME


def read_secrets(path) -> dict:
    """Parse a secrets file. Nothing in it is ever printed or logged."""
    candidate = pathlib.Path(path)
    if not candidate.is_file():
        raise SecretsError(
            "No secrets file at %s. Point SECRETS_FILE at the one for this "
            "host: SECRETS_FILE=deploy/.secrets.<host>.env" % candidate
        )
    return parse_env_text(candidate.read_text())


def local_preflight(secrets: dict, err=None) -> None:
    """The guards that run on the operator's machine, before anything moves."""
    if err is None:
        err = sys.stderr
    for warning in validate_secrets(secrets):
        err.write("WARNING: %s\n" % warning)


def push_self(ssh, out) -> None:
    """Copy this file to the box. The first act of every command.

    Everything afterwards that reads machine state -- the fingerprint of
    the key already installed, the pg_hba and nginx rewrites -- runs through
    this copy, so both halves of every comparison come from the same code.
    """
    out.write("==> pushing the deployer to %s\n" % REMOTE_SELF)
    ssh.push_file(str(pathlib.Path(__file__).resolve()), REMOTE_SELF)


def check_remote_budget(ssh, needs: dict, breakdown: str = "") -> None:
    """Measure the box's filesystems and refuse with the numbers, not halfway."""
    mounts = parse_df(ssh.run("df -PB1", check=False).stdout)
    if not mounts:
        # Better a warning than a refusal: a box whose df cannot be read is
        # not a box that is known to be full.
        sys.stderr.write("WARNING: could not read `df -PB1`; skipping the disk budget\n")
        return
    refusal = budget_refusal(check_budget(mounts, needs), breakdown)
    if refusal:
        raise Refusal(refusal)


def run_steps(ssh, steps: list, out) -> None:
    """Execute a plan, naming each step, stopping at the first failure."""
    total = len(steps)
    for index, step in enumerate(steps, 1):
        out.write("==> [%d/%d] %s\n" % (index, total, step.name))
        out.flush()
        result = ssh.run(step.command, check=False)
        if result.returncode != 0:
            raise Refusal(
                step_failure_message(
                    step.name, result.returncode, result.stderr, result.stdout
                )
            )


def poll_health(ssh, out, sleep=None) -> bool:
    """Poll for the API, twenty times, three seconds apart.

    One probe is not enough: on a 1-vCPU box Nest can take well over four
    seconds to bind, and a single check reports a false failure on a
    deployment that actually worked. deploy.sh records exactly that.
    """
    if sleep is None:
        sleep = time.sleep
    for attempt in range(1, HEALTH_ATTEMPTS + 1):
        if ssh.run(health_command(), check=False).returncode == 0:
            out.write("==> healthy after %d probe%s\n" % (attempt, "" if attempt == 1 else "s"))
            return True
        delay = poll_delay(attempt)
        if delay is None:
            return False
        sleep(delay)
    return False


def cmd_provision(args, out=None) -> int:
    """Take a bare RHEL 9 host to one ready to receive a deployment."""
    if out is None:
        out = sys.stdout
    steps = provision_steps()
    if args.dry_run:
        out.write(render_plan(steps))
        return 0

    # Local first, so a secrets file that cannot deploy never gets as far as
    # creating roles from it.
    path = secrets_path()
    secrets = read_secrets(path)
    local_preflight(secrets)

    ssh, host = target_ssh()
    out.write("==> provisioning %s\n" % host)
    push_self(ssh, out)
    check_remote_budget(
        ssh,
        provision_needs(),
        "nginx, Node 22, PostgreSQL 16, SELinux tooling and the dnf cache",
    )

    # Inside the try, not before it: push_text's remote `cat >` can create
    # the file and then have the transfer die, and the removal below would
    # never run -- leaving a partial secrets file on the box. The `rm -f` is
    # already harmless when the file was never created.
    try:
        ssh.push_text(
            remote_secrets_content(secrets, PROVISION_SECRET_KEYS),
            REMOTE_SECRETS,
            mode="600",
        )
        run_steps(ssh, steps, out)
    finally:
        ssh.run("rm -f %s" % REMOTE_SECRETS, check=False)
    out.write("PROVISION_OK\n")
    return 0


def cmd_deploy(args, out=None) -> int:
    """Build, push, migrate, restart and verify."""
    if out is None:
        out = sys.stdout
    if args.dry_run:
        out.write(render_plan(deploy_steps({})))
        return 0

    root = str(_DEPLOY_DIR.parent)
    path = secrets_path()
    secrets = read_secrets(path)
    local_preflight(secrets)

    ssh, host = target_ssh()
    out.write("==> deploying to %s\n" % host)
    push_self(ssh, out)

    # Fingerprints, before the payload rather than after: writing this .env
    # over a different key orphans every encrypted row in app_settings, and
    # nothing recovers them. Both fingerprints come from key_fingerprint --
    # the local one here, the remote one from the copy just pushed.
    probe = ssh.run(REMOTE_FINGERPRINT_COMMAND, check=False)
    refusal = fingerprint_probe_refusal(probe.returncode, probe.stderr, host)
    if refusal:
        raise Refusal(refusal)
    refusal = fingerprint_refusal(
        key_fingerprint(secrets.get("CRYPTO_MASTER_KEY", "")),
        probe.stdout,
        str(path),
        host,
    )
    if refusal:
        raise Refusal(refusal)

    check_remote_budget(ssh, deploy_needs(), deploy_breakdown())

    out.write("==> building\n")
    for directory, command in build_commands(root):
        result = subprocess.run(command, cwd=directory, shell=True)
        if result.returncode != 0:
            raise Refusal(
                "FATAL: `%s` failed in %s (exit %d). Nothing was pushed."
                % (command, directory, result.returncode)
            )

    out.write("==> syncing\n")
    for item in deploy_payload(root):
        if item.kind == "dir":
            ssh.push_dir(item.local, item.remote)
        else:
            ssh.push_file(item.local, item.remote)

    # Inside the try: see cmd_provision for why a transfer that dies after
    # the remote `cat >` created the file must still reach the removal.
    try:
        ssh.push_text(
            remote_secrets_content(secrets, DEPLOY_SECRET_KEYS),
            REMOTE_SECRETS,
            mode="600",
        )
        run_steps(ssh, deploy_steps(secrets), out)
        out.write("==> health\n")
        if not poll_health(ssh, out):
            sys.stderr.write(
                "FATAL: the API did not come up within %ds. Last log lines:\n"
                % (HEALTH_ATTEMPTS * HEALTH_INTERVAL_SECONDS)
            )
            sys.stderr.write(ssh.run(JOURNAL_TAIL_COMMAND, check=False).stdout)
            return 1
    finally:
        ssh.run("rm -f %s" % REMOTE_SECRETS, check=False)
    out.write("DEPLOY_OK\n")
    return 0


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
        if name == "doctor":
            # Internal: how the local half invokes the copy it pushed to the
            # box. Hidden because an operator never types it, and only on
            # doctor because only doctor has a local runner. provision and
            # deploy accepted it and then died on target_ssh's "No ssh
            # target", which is the least useful way to say "not supported".
            p.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
            p.add_argument(
                "--no-state",
                action="store_true",
                help="do not record this run's measurements (no growth projection)",
            )
            for group in DOCTOR_GROUPS:
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
    args = build_parser().parse_args(argv)

    if args.command in ("provision", "deploy"):
        command = cmd_provision if args.command == "provision" else cmd_deploy
        try:
            return command(args)
        except Refusal as exc:
            # Refusals already read as the operator-facing message they are;
            # anything else is a bug and should keep its traceback.
            sys.stderr.write("%s\n" % exc)
            return 1
        except RuntimeError as exc:
            sys.stderr.write("FATAL: %s\n" % exc)
            return 1

    if args.dry_run:
        sys.stdout.write(
            render_plan([Step(name, command) for name, command in DOCTOR_COMMANDS])
        )
        return 0
    try:
        runner = doctor_runner(args)
    except SecretsError as exc:
        sys.stderr.write("%s\n" % exc)
        return 2
    return cmd_doctor(args, runner)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
