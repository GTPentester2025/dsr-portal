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
import pathlib
import re
import subprocess
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


def _cat_heredoc_command(remote_path: str, content: str, marker: str = "DSR_EOF") -> str:
    """A `cat > remote_path <<'MARKER'` fragment carrying literal file content.

    The heredoc delimiter is quoted, so the remote shell does not expand
    anything inside -- the content lands byte-for-byte without a second SSH
    round trip for what push_file would otherwise do.
    """
    if not content.endswith("\n"):
        content += "\n"
    return "cat > %s <<'%s'\n%s%s" % (remote_path, marker, content, marker)


def _remote_text_fix(path: str, func_name: str) -> str:
    """Apply one of Task 4's pure text transforms to a file already on the box.

    Runs the copy of this tool already at REMOTE_SELF, so the same
    idempotent, comment-aware guard exercised by the unit tests decides
    whether anything changes -- never a shell sed re-deriving that logic on
    the box, where a wrong regex leaves an unbalanced config file.
    """
    remote_dir = REMOTE_SELF.rsplit("/", 1)[0]
    return (
        "python3 -c \""
        "import sys; sys.path.insert(0, '%s'); import dsr_deploy as d, pathlib; "
        "p = pathlib.Path('%s'); t = p.read_text(); "
        "new, changed = d.%s(t); "
        "p.write_text(new) if changed else None\""
    ) % (remote_dir, path, func_name)


def provision_steps() -> list:
    """The RHEL 9 provisioning sequence, in order.

    Each command is a shell fragment executed on the box, and every one is
    safe to run twice: `dnf install -y` is already idempotent, directory
    creation uses `mkdir -p` / `install -d`, `setsebool -P` is idempotent,
    and the two file rewrites go through Task 4's guarded, no-op-on-replay
    functions rather than an unconditional sed.
    """
    return [
        Step(
            "preflight: confirm RHEL 9 and disk headroom",
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
            "(command -v node >/dev/null 2>&1 && [ \"$(node -v | cut -c2-3)\" -ge 22 ]) || "
            "(dnf module reset -y nodejs >/dev/null 2>&1; "
            "dnf module enable -y nodejs:22 && dnf install -y nodejs && dnf clean all)",
        ),
        Step(
            "install PostgreSQL 16",
            "rpm -q postgresql-server >/dev/null 2>&1 || "
            "(dnf module reset -y postgresql >/dev/null 2>&1; "
            "dnf module enable -y postgresql:16 && "
            "dnf install -y postgresql-server postgresql-contrib && dnf clean all)",
        ),
        Step(
            "initialize the data directory (postgresql-setup --initdb)",
            "test -f /var/lib/pgsql/data/PG_VERSION || postgresql-setup --initdb; "
            "systemctl enable --now postgresql",
        ),
        Step(
            "pg_hba: require scram-sha-256 on loopback (Task 4's rewrite_pg_hba)",
            _remote_text_fix(PG_HBA_REMOTE, "rewrite_pg_hba")
            + "; systemctl reload postgresql",
        ),
        Step(
            "create the dsr and dsr_app roles and database",
            "sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL\n"
            "DO \\$\\$\n"
            "BEGIN\n"
            "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr') THEN\n"
            "    CREATE ROLE dsr LOGIN PASSWORD '${DB_PASS:?DB_PASS required}';\n"
            "  ELSE\n"
            "    ALTER ROLE dsr PASSWORD '${DB_PASS:?DB_PASS required}';\n"
            "  END IF;\n"
            "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dsr_app') THEN\n"
            "    CREATE ROLE dsr_app LOGIN PASSWORD '${APP_PASS:?APP_PASS required}';\n"
            "  ELSE\n"
            "    ALTER ROLE dsr_app PASSWORD '${APP_PASS:?APP_PASS required}';\n"
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
            "id -u dsr >/dev/null 2>&1 || "
            "useradd --system --no-create-home --home-dir %s --shell /sbin/nologin dsr; "
            "mkdir -p %s/server %s/public-form %s/admin; "
            "install -d -o dsr -g dsr -m 750 %s; "
            "chown -R dsr:dsr %s; "
            "chown -R nginx:nginx %s"
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
            _remote_text_fix(NGINX_MAIN_CONF_REMOTE, "neutralise_default_server")
            + " && systemctl enable --now nginx",
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
            "dnf install -y zram-generator && dnf clean all; "
            "printf '[zram0]\\nzram-size = min(ram / 2, 2048)\\n' "
            "> /etc/systemd/zram-generator.conf; "
            "systemctl daemon-reload; "
            "systemctl start systemd-zram-setup@zram0.service",
        ),
    ]


def _env_file_content(env: dict) -> str:
    """The service .env, in the same shape deploy.sh writes -- see its
    comments on why EMAIL_PROVIDER and COOKIE_SECURE live here rather than
    in app_settings.
    """
    lines = [
        "NODE_ENV=production",
        "PORT=%d" % APP_PORT,
        "DATABASE_URL=postgres://dsr:%s@127.0.0.1:5432/dsr" % env.get("DB_PASS", ""),
        "DATABASE_URL_APP=postgres://dsr_app:%s@127.0.0.1:5432/dsr" % env.get("APP_PASS", ""),
        "CRYPTO_MASTER_KEY=%s" % env.get("CRYPTO_MASTER_KEY", ""),
        "COOKIE_SECURE=%s" % env.get("COOKIE_SECURE", "true"),
        "EMAIL_PROVIDER=%s" % env.get("EMAIL_PROVIDER", "graph"),
        "PRIVACY_MAILBOX=%s" % env.get("PRIVACY_MAILBOX", ""),
        "GRAPH_TENANT_ID=%s" % env.get("GRAPH_TENANT_ID", ""),
        "GRAPH_CLIENT_ID=%s" % env.get("GRAPH_CLIENT_ID", ""),
        "GRAPH_CLIENT_SECRET=%s" % env.get("GRAPH_CLIENT_SECRET", ""),
    ]
    return "\n".join(lines) + "\n"


# Re-applies a Let's Encrypt certificate onto the freshly-pushed, HTTP-only
# nginx conf, and skips cleanly when no certificate has been issued yet.
# CERT_NAME is discovered on the box, inside this fragment, at run time --
# not by the operator's machine beforehand -- so this one Step stays static
# while still doing nothing on a box with no domain pointed at it yet.
_TLS_REAPPLY_COMMAND = (
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
_ENSURE_URLS_COMMAND = (
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
    """
    return [
        Step(
            "write /opt/dsr/server/.env (keep .env.bak first)",
            ("test -f %s && cp %s %s.bak || true\n" % (ENV_PATH, ENV_PATH, ENV_PATH))
            + _cat_heredoc_command(ENV_PATH, _env_file_content(env), "ENV")
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
            "cd %s/server && set -a && . ./.env && set +a && "
            "node scripts/import-forms.mjs | tail -1" % INSTALL_PREFIX,
        ),
        Step(
            "fix ownership and SELinux context (restorecon)",
            "chown -R dsr:dsr %s; chown -R nginx:nginx %s; "
            "mkdir -p %s && chown dsr:dsr %s && chmod 750 %s; "
            "restorecon -R %s %s"
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
            _cat_heredoc_command(UNIT_REMOTE, UNIT_FILE_LOCAL.read_text(), "DSR_UNIT_EOF")
            + "\n"
            + _cat_heredoc_command(
                NGINX_SITE_CONF_REMOTE, NGINX_CONF_LOCAL.read_text(), "DSR_NGINX_EOF"
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
            "systemctl enable --now %s >/dev/null 2>&1; systemctl restart %s"
            % (SERVICE, SERVICE),
        ),
        Step(
            "reload nginx",
            "systemctl reload nginx",
        ),
    ]


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
    args = build_parser().parse_args(argv)

    # Executing steps for real -- picking a target, pushing this file to the
    # box, running Ssh.run over each Step -- is the next task's job. What is
    # already true is that the plan is data, so a dry run can print it now
    # without touching a host.
    if args.command in ("provision", "deploy"):
        steps = provision_steps() if args.command == "provision" else deploy_steps({})
        if args.dry_run:
            sys.stdout.write(render_plan(steps))
            return 0
        sys.stderr.write(
            "%s does not run against a live host yet in this build; "
            "use --dry-run to see the plan.\n" % args.command
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
