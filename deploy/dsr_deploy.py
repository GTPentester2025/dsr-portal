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
