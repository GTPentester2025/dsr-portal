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
import collections
import hashlib
import re
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
