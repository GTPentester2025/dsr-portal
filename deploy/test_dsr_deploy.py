from __future__ import annotations

import base64
import collections
import contextlib
import io
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import dsr_deploy as dd


def is_ancestor_of(candidate: str, path: str) -> bool:
    """True when `candidate` is `path` or a directory containing it.

    push_dir mirrors a directory by removing its destination first, so a
    payload entry targeting /opt/dsr destroys /opt/dsr/uploads without the
    string "uploads" appearing anywhere in it.
    """
    candidate = candidate.rstrip("/")
    return path == candidate or path.startswith(candidate + "/")


class TestUploadsAncestry(unittest.TestCase):
    """Holds is_ancestor_of up, so the payload tests below cannot pass by
    calling a helper that always answers False."""

    def test_the_path_itself_and_its_parents_count(self):
        self.assertTrue(is_ancestor_of("/opt/dsr/uploads", dd.UPLOADS_DIR))
        self.assertTrue(is_ancestor_of("/opt/dsr/uploads/", dd.UPLOADS_DIR))
        self.assertTrue(is_ancestor_of("/opt/dsr", dd.UPLOADS_DIR))
        self.assertTrue(is_ancestor_of("/", dd.UPLOADS_DIR))

    def test_a_sibling_or_a_child_does_not(self):
        self.assertFalse(is_ancestor_of("/opt/dsr/server/dist", dd.UPLOADS_DIR))
        self.assertFalse(is_ancestor_of("/opt/dsrx", dd.UPLOADS_DIR))
        self.assertFalse(is_ancestor_of("/var/www/dsr/admin", dd.UPLOADS_DIR))


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
        # format_help() on the top-level parser never lists a subparser's own
        # arguments, so asserting against it proves nothing -- --remote must
        # be checked against the "doctor" subcommand's own help text, which
        # is where argparse.SUPPRESS actually has an effect.
        subparsers_action = dd.build_parser()._subparsers._group_actions[0]
        doctor_help = subparsers_action.choices["doctor"].format_help()
        self.assertNotIn("--remote", doctor_help)

    def test_remote_is_a_doctor_only_flag(self):
        # provision --remote and deploy --remote used to parse and then die
        # on target_ssh's "No ssh target", because nothing but doctor has a
        # local runner. Rejecting them at the parser says so at once.
        for command in ("provision", "deploy"):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    dd.build_parser().parse_args([command, "--remote"])

    def test_the_missing_target_message_names_the_command_that_takes_remote(self):
        missing = pathlib.Path(tempfile.gettempdir()) / "dsr-no-such-target.env"
        with unittest.mock.patch.object(dd, "TARGET_ENV_LOCAL", missing):
            with self.assertRaises(dd.SecretsError) as caught:
                dd.target_ssh()
        message = str(caught.exception)
        self.assertIn(".target.env", message)
        self.assertIn("doctor --remote", message)

    def test_doctor_takes_no_state_and_group_filters(self):
        args = dd.build_parser().parse_args(["doctor", "--no-state", "--disk"])
        self.assertTrue(args.no_state)
        self.assertTrue(args.disk)

    def test_no_command_is_an_error_not_a_crash(self):
        with self.assertRaises(SystemExit):
            dd.build_parser().parse_args([])


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


DF_SEPARATE = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     10737418240 8589934592 2147483648      80% /
/dev/vdb1     10737418240 9663676416 1073741824      90% /var
/dev/vdc1     10737418240 5368709120 5368709120      50% /home
"""

DF_NUMERIC_FIRST_LINE = """/dev/header    10737418240 5368709120 5368709120      50% /header
/dev/vda1      10737418240 8589934592 2147483648      80% /
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
        # Weak on its own: df's real header is thrown out by the numeric
        # filter too, because "1B-blocks" is not an int. The test below is
        # the one that holds the [1:] slice in place.
        self.assertTrue(all(m.device != "Filesystem" for m in dd.parse_df(DF_SEPARATE)))

    def test_the_first_line_is_dropped_even_when_it_would_parse(self):
        # A first line whose columns are all numeric: nothing but the [1:]
        # slice can exclude it. Verified by deleting the slice and watching
        # this fail with ['/header', '/'] before restoring it.
        text = DF_NUMERIC_FIRST_LINE
        self.assertEqual([m.mountpoint for m in dd.parse_df(text)], ["/"])

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
        self.assertIn("1.0 GiB", refusals[0])
        self.assertIn("3.7 GiB", refusals[0])

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
        self.assertEqual(dd.human_bytes(1024), "1.0 KiB")
        self.assertEqual(dd.human_bytes(1073741824), "1.0 GiB")

    def test_the_label_matches_the_divisor(self):
        # The divisor is 1024. Under an MB/GB label the printed number
        # disagreed with the constant it came from: DEPLOY_BYTES is
        # 420 * 1000 * 1000 and printed "400.5 MB", and the breakdown read
        # "node_modules ~295.6 MB" where the source says 310 MB.
        self.assertEqual(dd.human_bytes(1024 ** 2), "1.0 MiB")
        self.assertEqual(dd.human_bytes(1000 * 1000), "976.6 KiB")
        for text in (dd.human_bytes(dd.DEPLOY_BYTES), dd.deploy_breakdown()):
            self.assertNotIn(" MB", text)
            self.assertNotIn(" GB", text)


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


PG_HBA_RHEL_DEFAULT = """# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     peer
host    all             all             127.0.0.1/32            ident
host    all             all             ::1/128                 ident
host    replication     all             127.0.0.1/32            ident
"""


class TestPgHba(unittest.TestCase):
    @staticmethod
    def body(text):
        """rewrite_pg_hba's output with the managed-marker header split off.

        The marker is the operator-facing half of the spec's promise --
        nothing in pg_hba.conf said this tool had edited it -- and every
        assertion below is about the rules underneath it.
        """
        new, changed = dd.rewrite_pg_hba(text)
        if changed:
            assert new.startswith(dd.PG_HBA_MARKER + "\n"), new[:80]
            return new.split("\n", 1)[1], changed
        return new, changed

    def test_a_changed_file_says_who_changed_it(self):
        new, changed = dd.rewrite_pg_hba("host all all 127.0.0.1/32 ident\n")
        self.assertTrue(changed)
        self.assertTrue(new.startswith(dd.MANAGED_MARKER))
        self.assertIn("pg_hba.conf.orig", new.splitlines()[0])

    def test_an_unchanged_file_gains_no_marker(self):
        text = "host all all 127.0.0.1/32 scram-sha-256\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertNotIn(dd.MANAGED_MARKER, new)

    def test_a_marked_file_is_left_entirely_alone(self):
        # Even one that has since had a weak rule added by hand: this tool
        # has said its piece about the file, and re-editing a file an
        # operator has taken over is not its business.
        text = dd.PG_HBA_MARKER + "\nhost all all 127.0.0.1/32 md5\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_loopback_ident_becomes_scram(self):
        new, changed = self.body(PG_HBA_RHEL_DEFAULT)
        self.assertTrue(changed)
        for line in new.splitlines():
            if (
                line.startswith("host")
                and "replication" not in line
                and ("127.0.0.1/32" in line or "::1/128" in line)
            ):
                self.assertIn("scram-sha-256", line)
                self.assertNotIn("ident", line)

    def test_local_peer_line_is_left_alone(self):
        new, _ = self.body(PG_HBA_RHEL_DEFAULT)
        self.assertIn("local   all             all                                     peer", new)

    def test_replication_line_is_left_alone(self):
        new, _ = self.body(PG_HBA_RHEL_DEFAULT)
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
        new, changed = self.body("host all all 127.0.0.1/32 md5\n")
        self.assertTrue(changed)
        self.assertIn("scram-sha-256", new)

    # The five shapes below all failed identically before this was fixed:
    # the rule stayed on `ident`, the API authenticated against nothing, and
    # the portal booted and then could not read its own database. Nothing in
    # the symptom names the file.

    def test_the_plain_cidr_rule_is_rewritten(self):
        new, changed = self.body("host all all 127.0.0.1/32 ident\n")
        self.assertTrue(changed)
        self.assertEqual(new, "host all all 127.0.0.1/32 scram-sha-256\n")

    def test_a_trailing_comment_does_not_hide_the_method(self):
        new, changed = self.body("host all all 127.0.0.1/32 ident  # legacy\n")
        self.assertTrue(changed)
        self.assertIn("scram-sha-256", new)
        self.assertIn("# legacy", new)

    def test_a_trailing_option_does_not_hide_the_method(self):
        new, changed = self.body(
            "host all all 127.0.0.1/32 md5 clientcert=verify-full\n"
        )
        self.assertTrue(changed)
        self.assertIn("scram-sha-256 clientcert=verify-full", new)

    def test_the_address_netmask_form_counts_as_loopback(self):
        new, changed = self.body(
            "host all all 127.0.0.1 255.255.255.255 ident\n"
        )
        self.assertTrue(changed)
        self.assertIn("255.255.255.255 scram-sha-256", new)

    def test_localhost_and_samehost_count_as_loopback(self):
        for address in ("localhost", "samehost"):
            new, changed = self.body("host all all %s ident\n" % address)
            self.assertTrue(changed, address)
            self.assertIn("scram-sha-256", new)

    def test_a_non_loopback_rule_is_still_left_alone(self):
        # Widening what counts as loopback must not widen it to everything:
        # rewriting a remote rule is not this tool's business.
        text = "host all all 10.0.0.0/8 md5\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_the_rewritten_rules_are_still_idempotent(self):
        text = (
            "host all all 127.0.0.1/32 ident  # legacy\n"
            "host all all 127.0.0.1 255.255.255.255 ident\n"
            "host all all localhost md5 clientcert=verify-full\n"
        )
        once, changed = dd.rewrite_pg_hba(text)
        self.assertTrue(changed)
        twice, changed_again = dd.rewrite_pg_hba(once)
        self.assertFalse(changed_again)
        self.assertEqual(once, twice)

    def test_replication_is_left_alone_in_every_shape(self):
        for line in (
            "host replication all 127.0.0.1/32 ident\n",
            "host replication all 127.0.0.1 255.255.255.255 ident  # standby\n",
        ):
            new, changed = dd.rewrite_pg_hba(line)
            self.assertFalse(changed, line)
            self.assertEqual(new, line)

    # hostssl and hostnossl are the same rule with a TLS requirement bolted
    # on. Matching only `host` left them on ident, and the box then failed in
    # exactly the way this function exists to prevent: the portal boots, and
    # cannot read its own database.

    def test_every_tcp_connection_type_is_rewritten(self):
        for kind in ("host", "hostssl", "hostnossl"):
            new, changed = self.body("%s all all 127.0.0.1/32 ident\n" % kind)
            self.assertTrue(changed, kind)
            self.assertEqual(new, "%s all all 127.0.0.1/32 scram-sha-256\n" % kind)

    def test_every_tcp_connection_type_survives_every_shape(self):
        for kind in ("hostssl", "hostnossl"):
            for line, expected in (
                ("%s all all 127.0.0.1/32 ident  # legacy" % kind, "# legacy"),
                (
                    "%s all all 127.0.0.1/32 md5 clientcert=verify-full" % kind,
                    "scram-sha-256 clientcert=verify-full",
                ),
                (
                    "%s all all 127.0.0.1 255.255.255.255 ident" % kind,
                    "255.255.255.255 scram-sha-256",
                ),
                ("%s all all localhost ident" % kind, "scram-sha-256"),
                ("%s all all samehost md5" % kind, "scram-sha-256"),
                ("%s all all ::1/128 ident" % kind, "scram-sha-256"),
            ):
                new, changed = self.body(line + "\n")
                self.assertTrue(changed, line)
                self.assertIn("scram-sha-256", new, line)
                self.assertIn(expected, new, line)
                self.assertTrue(new.startswith(kind), line)
                # Idempotency is checked on the real output, marker and
                # all: the marker is now what stops the second pass.
                marked, _ = dd.rewrite_pg_hba(line + "\n")
                twice, again = dd.rewrite_pg_hba(marked)
                self.assertFalse(again, line)
                self.assertEqual(marked, twice, line)

    def test_replication_is_left_alone_for_every_tcp_connection_type(self):
        for kind in ("host", "hostssl", "hostnossl"):
            line = "%s replication all 127.0.0.1/32 ident\n" % kind
            new, changed = dd.rewrite_pg_hba(line)
            self.assertFalse(changed, kind)
            self.assertEqual(new, line)

    def test_a_remote_hostssl_rule_is_still_left_alone(self):
        # Widening the connection type must not widen what counts as
        # loopback.
        text = "hostssl all all 10.0.0.0/8 md5\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_a_commented_hostssl_rule_is_not_rewritten(self):
        text = "# hostssl all all 127.0.0.1/32 ident\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_a_word_merely_starting_with_host_is_not_a_connection_type(self):
        text = "hostile all all 127.0.0.1/32 ident\n"
        new, changed = dd.rewrite_pg_hba(text)
        self.assertFalse(changed)
        self.assertEqual(new, text)

    def test_column_alignment_survives_the_rewrite(self):
        new, _ = self.body(
            "host    all             all             127.0.0.1/32            ident\n"
        )
        self.assertEqual(
            new,
            "host    all             all             127.0.0.1/32            scram-sha-256\n",
        )


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

    def test_the_brace_may_be_on_the_next_line(self):
        # `server` and `{` on separate lines is legal nginx, and the old
        # endswith("{") test left the stock block in place -- so nginx kept
        # refusing to start with `duplicate default server`.
        text = "http {\n    server\n    {\n        listen 80 default_server;\n    }\n}\n"
        new, changed = dd.neutralise_default_server(text)
        self.assertTrue(changed)
        self.assertNotIn("default_server", new)
        self.assertEqual(new.count("{"), new.count("}"))

    def test_a_comment_after_the_brace_does_not_hide_the_opener(self):
        text = "http {\n    server { # default\n        listen 80 default_server;\n    }\n}\n"
        new, changed = dd.neutralise_default_server(text)
        self.assertTrue(changed)
        self.assertNotIn("default_server", new)
        self.assertEqual(new.count("{"), new.count("}"))

    def test_an_upstream_server_directive_is_not_mistaken_for_a_block(self):
        # `server 127.0.0.1:3000;` inside an upstream block starts with the
        # word server and opens nothing; swallowing it would break the proxy
        # this whole config exists to set up.
        text = (
            "http {\n"
            "    upstream api {\n"
            "        server 127.0.0.1:3000;\n"
            "    }\n"
            "    server {\n"
            "        listen 80 default_server;\n"
            "    }\n"
            "}\n"
        )
        new, changed = dd.neutralise_default_server(text)
        self.assertTrue(changed)
        self.assertIn("server 127.0.0.1:3000;", new)
        self.assertIn("upstream api {", new)
        self.assertNotIn("default_server", new)
        self.assertEqual(new.count("{"), new.count("}"))

    def test_server_name_is_not_a_block_opener(self):
        self.assertFalse(dd._opens_server_block("    server_name _;"))
        self.assertTrue(dd._opens_server_block("    server {"))
        self.assertTrue(dd._opens_server_block("server"))
        self.assertFalse(dd._opens_server_block("        server 127.0.0.1:3000;"))

    def test_a_block_that_never_closes_is_left_alone(self):
        # A truncated file is a reason to change nothing, not a reason to
        # write out an unbalanced one and have nginx fail for a second,
        # more confusing reason.
        text = "http {\n    server {\n        listen 80 default_server;\n"
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


class TestPlans(unittest.TestCase):
    def test_provision_covers_every_step_the_spec_lists(self):
        names = " ".join(s.name for s in dd.provision_steps()).lower()
        for expected in (
            "package", "node", "postgres", "initdb", "pg_hba", "role",
            "user", "selinux", "nginx", "firewall", "journal", "zram",
        ):
            self.assertIn(expected, names, "provision has no %s step" % expected)

    # `enforce` is not a substring of `enforcing`, which left the officially
    # documented way to boot RHEL permissive walking straight through this
    # net: `grubby --update-kernel=ALL --args="enforcing=0"`. One character.
    FORBIDDEN_SELINUX = re.compile(r"selinux|enforc|permissive", re.IGNORECASE)

    def test_the_prohibition_catches_every_documented_way_to_disable_selinux(self):
        for command in (
            'grubby --update-kernel=ALL --args="enforcing=0"',
            "setenforce 0",
            "semanage permissive -a httpd_t",
            "echo 0 > /sys/fs/selinux/enforce",
            "sed -i 's/SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config",
        ):
            self.assertIsNotNone(
                self.FORBIDDEN_SELINUX.search(command),
                "%r would slip past the SELinux prohibition" % command,
            )

    def test_the_prohibition_still_permits_the_commands_this_tool_is_for(self):
        # A net that catches setsebool and restorecon is a net nobody can
        # keep, so this is the other half of the pattern's contract.
        for command in (
            "setsebool -P httpd_can_network_connect on",
            "restorecon -R /opt/dsr /var/www/dsr",
            "dnf install -y policycoreutils-python-utils",
            "nginx -t && systemctl enable --now nginx",
        ):
            self.assertIsNone(self.FORBIDDEN_SELINUX.search(command), command)

    def test_provision_never_disables_selinux(self):
        # Widened from three exact substrings to a pattern, because the
        # three had blind spots wide enough to drive through and all of
        # these passed the old check:
        #     semanage permissive -a httpd_t
        #     echo 0 > /sys/fs/selinux/enforce
        #     sed -i 's/SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
        # None of them is in the file today. This test is the safety net for
        # every future edit, so it has to catch the ones nobody thought of.
        #
        # `setsebool -P httpd_can_network_connect on` and `restorecon` are
        # the SELinux commands this tool is *for*, and neither matches.
        for step in dd.provision_steps() + dd.deploy_steps({}):
            match = self.FORBIDDEN_SELINUX.search(step.command)
            self.assertIsNone(
                match,
                "step %r reaches for SELinux: %r. Turning it off is the fix "
                "people reach for on a RHEL 502, it is wrong, and this box "
                "holds identity documents. Set httpd_can_network_connect "
                "instead." % (step.name, match.group(0) if match else ""),
            )

    def test_the_role_sql_escapes_the_password_for_sql_not_just_for_the_shell(self):
        # shell_quote protects the shell layer. Nothing protected the SQL
        # layer: an apostrophe closed the string literal, psql failed, and
        # psql echoes the offending statement in its `LINE n:` context --
        # which step_failure_message prints verbatim, password and all.
        step = [s for s in dd.provision_steps() if "role" in s.name][0]
        doubling = "//\\'/\\'\\'}"
        self.assertIn("DB_PASS_SQL=${DB_PASS_SQL" + doubling, step.command)
        self.assertIn("APP_PASS_SQL=${APP_PASS_SQL" + doubling, step.command)

    def test_no_sql_password_literal_interpolates_the_raw_value(self):
        step = [s for s in dd.provision_steps() if "role" in s.name][0]
        literals = [l for l in step.command.splitlines() if "PASSWORD '" in l]
        self.assertEqual(len(literals), 4)
        for line in literals:
            self.assertIn("_SQL}", line, line)
            self.assertNotIn("${DB_PASS}", line)
            self.assertNotIn("${APP_PASS}", line)
            self.assertNotIn(":?", line)

    def test_the_required_check_moved_up_rather_than_being_dropped(self):
        # `${DB_PASS:?}` was what stopped an empty password reaching the
        # role; it now guards the assignment instead of the SQL.
        step = [s for s in dd.provision_steps() if "role" in s.name][0]
        self.assertIn("DB_PASS_SQL=${DB_PASS:?DB_PASS required}", step.command)
        self.assertIn("APP_PASS_SQL=${APP_PASS:?APP_PASS required}", step.command)

    def test_provision_turns_the_proxy_boolean_on(self):
        blob = " ".join(s.command for s in dd.provision_steps())
        self.assertIn("httpd_can_network_connect", blob)
        self.assertIn("setsebool -P", blob)

    # A deletion verb anywhere near the uploads path. The old check was two
    # exact spellings of `rm -rf`, which let all of these through:
    #     rm  -rf /opt/dsr/uploads          (two spaces)
    #     find /opt/dsr/uploads -mindepth 1 -delete
    #     shred /opt/dsr/uploads/*
    #     mv /opt/dsr/uploads /tmp
    # None is in the file today. The point of this test is the edit that has
    # not happened yet: these are identity documents held as regulatory
    # records, and no step of this tool may remove, prune, truncate or
    # relocate them.
    DESTRUCTIVE_NEAR_UPLOADS = re.compile(
        r"\b(rm|rmdir|unlink|shred|truncate|mv|find|dd)\b[^\n;&|]*uploads"
        r"|uploads[^\n;&|]*(-delete|-exec\s+rm|--remove|\bshred\b|\btruncate\b)",
        re.IGNORECASE,
    )

    def test_no_step_anywhere_removes_uploads(self):
        every = dd.provision_steps() + dd.deploy_steps({"EMAIL_PROVIDER": "console"})
        for step in every:
            match = self.DESTRUCTIVE_NEAR_UPLOADS.search(step.command)
            self.assertIsNone(
                match,
                "step %r would destroy uploaded identity documents: %r"
                % (step.name, match.group(0) if match else ""),
            )

    def test_no_payload_destination_is_the_uploads_directory(self):
        # push_dir mirrors by removing the destination first, so this is the
        # other way uploads could be deleted without a step ever saying rm.
        # Substring matching is not enough: a future entry pushing to
        # /opt/dsr would take the identity documents with it while
        # containing no "uploads" at all.
        for item in dd.deploy_payload("/repo"):
            self.assertIsNone(self.DESTRUCTIVE_NEAR_UPLOADS.search(item.remote))
            self.assertFalse(
                is_ancestor_of(item.remote, dd.UPLOADS_DIR),
                "%s is %s or contains it" % (item.remote, dd.UPLOADS_DIR),
            )

    def test_deploy_migrates_before_it_restarts(self):
        names = [s.name for s in dd.deploy_steps({"EMAIL_PROVIDER": "console"})]
        self.assertLess(
            [i for i, n in enumerate(names) if "migrat" in n.lower()][0],
            [i for i, n in enumerate(names) if "restart" in n.lower()][0],
        )

    def test_no_step_lets_a_semicolon_hide_a_failed_command(self):
        # `A; B` reports B's exit code. The pg_hba step was
        # `<rewrite>; systemctl reload postgresql`: a rewrite that died
        # mid-write left the file empty, the reload succeeded, and
        # Ssh.run(check=True) saw a healthy step on a box that could no
        # longer authenticate a single connection.
        for step in dd.provision_steps() + dd.deploy_steps({}):
            for line in step.command.splitlines():
                self.assertNotIn("; systemctl", line, step.name)
                self.assertNotIn("; chown", line, step.name)
                self.assertNotIn("; restorecon", line, step.name)

    def test_the_pg_hba_step_joins_its_reload_with_and(self):
        step = [s for s in dd.provision_steps() if "pg_hba" in s.name][0]
        self.assertIn("&& systemctl reload postgresql", step.command)

    def test_nginx_is_validated_before_it_is_started(self):
        # The step just edited nginx.conf. Starting nginx on a config it
        # cannot parse reports a systemd failure naming the unit, not the
        # line. deploy_steps already orders it this way.
        step = [s for s in dd.provision_steps() if s.name.startswith("nginx")][0]
        self.assertIn("nginx -t", step.command)
        self.assertLess(
            step.command.index("nginx -t"),
            step.command.index("systemctl enable --now nginx"),
        )

    def test_the_initdb_step_joins_its_enable_with_and(self):
        step = [s for s in dd.provision_steps() if "initdb" in s.name][0]
        self.assertIn("&& systemctl enable --now postgresql", step.command)

    def test_both_rewritten_config_files_are_backed_up_first(self):
        # Spec provisioning items 5 and 9 promise these two .orig copies.
        blob = " ".join(s.command for s in dd.provision_steps())
        self.assertIn("%s.orig" % dd.PG_HBA_REMOTE, blob)
        self.assertIn("%s.orig" % dd.NGINX_MAIN_CONF_REMOTE, blob)

    def test_the_backup_is_taken_before_the_rewrite_not_after(self):
        for step in dd.provision_steps():
            if ".orig" not in step.command:
                continue
            self.assertLess(
                step.command.index(".orig"),
                step.command.index("dsr_deploy as d"),
                step.name,
            )

    def test_a_second_run_cannot_overwrite_the_true_original(self):
        # Unconditional `cp` on a re-run would replace the pristine copy
        # with the already-rewritten one, and the backup would then record
        # nothing at all.
        for path in (dd.PG_HBA_REMOTE, dd.NGINX_MAIN_CONF_REMOTE):
            command = dd._backup_once(path)
            self.assertTrue(command.startswith("test -f %s.orig ||" % path), command)

    def test_the_backup_preserves_mode_and_ownership(self):
        self.assertIn("cp -p", dd._backup_once("/etc/nginx/nginx.conf"))

    def test_every_config_rewrite_is_written_atomically(self):
        # A truncating write is the failure atomic_write exists to remove;
        # a step that reached for p.write_text again would reintroduce it.
        rewrites = [s for s in dd.provision_steps() if "dsr_deploy as d" in s.command]
        self.assertEqual(len(rewrites), 2)
        for step in rewrites:
            self.assertIn("atomic_write", step.command, step.name)
            self.assertNotIn("write_text", step.command, step.name)

    def test_a_missing_shipped_file_is_a_refusal_not_a_traceback(self):
        # deploy_steps embeds nginx.conf and the unit file, so --dry-run
        # reads them too, and a missing one raised FileNotFoundError out of
        # main at an operator who had only asked what would happen.
        missing = pathlib.Path(tempfile.gettempdir()) / "dsr-no-such-nginx.conf"
        with unittest.mock.patch.object(dd, "NGINX_CONF_LOCAL", missing):
            with self.assertRaises(dd.Refusal) as caught:
                dd.deploy_steps({})
        self.assertIn("dsr-no-such-nginx.conf", str(caught.exception))

    def test_main_turns_a_missing_shipped_file_into_an_exit_code(self):
        missing = pathlib.Path(tempfile.gettempdir()) / "dsr-no-such-unit.service"
        err = io.StringIO()
        with unittest.mock.patch.object(dd, "UNIT_FILE_LOCAL", missing):
            with contextlib.redirect_stderr(err):
                with contextlib.redirect_stdout(io.StringIO()):
                    code = dd.main(["deploy", "--dry-run"])
        self.assertEqual(code, 1)
        self.assertIn("dsr-no-such-unit.service", err.getvalue())

    def test_render_plan_numbers_the_steps_and_shows_commands(self):
        text = dd.render_plan([dd.Step("do a thing", "echo hi")])
        self.assertIn("do a thing", text)
        self.assertIn("echo hi", text)
        self.assertIn("1", text)


# A box with a separate /var: room under / for the installed packages, but
# not enough in /var/cache for the downloads that produce them.
DF_SEPARATE_VAR_TOO_SMALL = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     42949672960 4294967296 38654705664      10% /
/dev/vdb1      2147483648 2040109465  107374183      95% /var
"""

# The target box: ~10 GB, mostly used. 240 MB free is less than the ~420 MB
# a deployment spends, so the refusal below is a path an operator will really
# take rather than a formality.
DF_SINGLE_ROOT_NEARLY_FULL = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     10737418240 10485760000  251658240      98% /
"""


# A box with room to spare, so a budget check in a command-level test passes
# on its own terms rather than on parse_df returning nothing.
DF_PLENTY = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1     42949672960 4294967296 38654705664      10% /
"""


class FakeSsh:
    """Records commands instead of running them. No host, by design.

    `fail_until` makes the first N calls fail, which is how a slow-starting
    API is simulated; `fail_on` fails one specific command. `responses` maps
    an exact command to the (returncode, stdout, stderr) it should answer
    with, which is how the fingerprint probe and `df -PB1` are driven.

    push_file / push_text / push_dir record rather than move bytes: the
    destination of a push is the thing worth asserting on, and one of them
    mirrors a directory by deleting it first.
    """

    Result = collections.namedtuple("Result", "returncode stdout stderr")

    def __init__(self, fail_until=0, fail_on=None, stderr="", responses=None):
        self.commands = []
        self.fail_until = fail_until
        self.fail_on = fail_on
        self.stderr = stderr
        self.responses = dict(responses or {})
        self.pushed_files = []
        self.pushed_texts = []
        self.pushed_dirs = []
        # One ordered log across runs and pushes. Two separate lists cannot
        # answer "did the fingerprint probe happen before the first
        # push_dir", and that ordering is the thing worth pinning: push_dir
        # mirrors a directory by deleting it first, so every guard has to
        # come before it.
        self.events = []

    def run(self, command, check=True):
        self.commands.append(command)
        self.events.append(("run", command))
        if command in self.responses:
            return self.Result(*self.responses[command])
        failed = len(self.commands) <= self.fail_until or command == self.fail_on
        return self.Result(1 if failed else 0, "", self.stderr if failed else "")

    def push_file(self, local, remote):
        self.pushed_files.append((local, remote))
        self.events.append(("push_file", remote))

    def push_text(self, text, remote, mode=""):
        self.pushed_texts.append((text, remote, mode))
        self.events.append(("push_text", remote))

    def push_dir(self, local, remote):
        self.pushed_dirs.append((local, remote))
        self.events.append(("push_dir", remote))

    def index_of_run(self, command):
        return self.events.index(("run", command))

    def first_index_of(self, kind):
        for position, event in enumerate(self.events):
            if event[0] == kind:
                return position
        return None


class TestSecretsStaging(unittest.TestCase):
    def test_no_step_ever_carries_a_secret_value(self):
        # A Step is what --dry-run prints and what ssh puts in the box's
        # process table. Values belong in REMOTE_SECRETS, mode 0600, fed
        # over stdin -- never in a command.
        secrets = {
            "DB_PASS": "swordfish-db",
            "APP_PASS": "swordfish-app",
            "CRYPTO_MASTER_KEY": base64.b64encode(b"\x07" * 32).decode(),
            "GRAPH_CLIENT_SECRET": "swordfish-graph",
        }
        blob = " ".join(
            s.command for s in dd.provision_steps() + dd.deploy_steps(secrets)
        )
        for value in secrets.values():
            self.assertNotIn(value, blob)

    def test_the_steps_that_need_secrets_source_the_staged_file(self):
        needing = [
            s
            for s in dd.provision_steps() + dd.deploy_steps({})
            if "${DB_PASS" in s.command or "${CRYPTO_MASTER_KEY" in s.command
        ]
        self.assertTrue(needing)
        for step in needing:
            self.assertIn(". %s" % dd.REMOTE_SECRETS, step.command, step.name)

    def test_the_env_heredoc_is_unquoted_so_the_shell_expands_it(self):
        step = [s for s in dd.deploy_steps({}) if ".env" in s.name][0]
        self.assertIn("cat > %s <<ENV" % dd.ENV_PATH, step.command)
        self.assertNotIn("<<'ENV'", step.command)

    def test_every_other_heredoc_stays_quoted(self):
        # An unquoted heredoc expands $ and backticks; the unit file and the
        # nginx config contain both and must land byte-for-byte.
        for step in dd.deploy_steps({}):
            if ".env" in step.name:
                continue
            for line in step.command.splitlines():
                if line.startswith("cat > "):
                    self.assertIn("<<'", line, step.name)


class TestShellQuoting(unittest.TestCase):
    def test_a_plain_value_is_quoted(self):
        self.assertEqual(dd.shell_quote("hunter2"), "'hunter2'")

    def test_an_apostrophe_survives(self):
        # A password with a quote in it is not exotic, and unquoted it
        # truncates silently into both .env and the postgres role.
        quoted = dd.shell_quote("it's fine")
        self.assertEqual(quoted, "'it'\\''s fine'")

    def test_the_quoting_round_trips_through_a_real_shell(self):
        content = dd.remote_secrets_content({"DB_PASS": "a'b$c `d` \"e\""}, ("DB_PASS",))
        parsed = dd.parse_env_text(content)
        # parse_env_text strips the outer quotes; the inner escape is the
        # shell's business, so check the shape rather than re-parsing it.
        self.assertTrue(content.startswith("DB_PASS='"))
        self.assertTrue(content.endswith("'\n"))
        self.assertIn("$c", parsed["DB_PASS"])

    def test_a_missing_key_is_written_empty_rather_than_omitted(self):
        content = dd.remote_secrets_content({}, ("DB_PASS", "APP_PASS"))
        self.assertEqual(content, "DB_PASS=''\nAPP_PASS=''\n")

    def test_provision_stages_only_what_it_needs(self):
        self.assertEqual(dd.PROVISION_SECRET_KEYS, ("DB_PASS", "APP_PASS"))
        self.assertIn("CRYPTO_MASTER_KEY", dd.DEPLOY_SECRET_KEYS)


class TestLocalPreflight(unittest.TestCase):
    GOOD = {
        "CRYPTO_MASTER_KEY": base64.b64encode(b"\x01" * 32).decode(),
        "DB_PASS": "db-pass",
        "APP_PASS": "app-pass",
        "EMAIL_PROVIDER": "graph",
        "PRIVACY_MAILBOX": "p@e.com",
        "GRAPH_TENANT_ID": "t",
        "GRAPH_CLIENT_ID": "c",
        "GRAPH_CLIENT_SECRET": "s",
    }

    def test_a_good_secrets_file_passes_without_warning(self):
        self.assertEqual(dd.validate_secrets(dict(self.GOOD)), [])

    def test_a_hex_master_key_is_refused_before_anything_is_pushed(self):
        env = dict(self.GOOD)
        env["CRYPTO_MASTER_KEY"] = "a" * 64
        with self.assertRaises(dd.SecretsError):
            dd.validate_secrets(env)

    def test_a_missing_graph_credential_is_refused_and_named(self):
        env = dict(self.GOOD)
        env["GRAPH_CLIENT_SECRET"] = ""
        with self.assertRaises(dd.SecretsError) as caught:
            dd.validate_secrets(env)
        self.assertIn("GRAPH_CLIENT_SECRET", str(caught.exception))

    def test_the_key_is_checked_before_the_mailer(self):
        # Both are broken; the master key is the one that cannot be fixed
        # after the fact, so it must be the one reported.
        with self.assertRaises(dd.SecretsError) as caught:
            dd.validate_secrets({"CRYPTO_MASTER_KEY": "", "EMAIL_PROVIDER": "smtp"})
        self.assertIn("CRYPTO_MASTER_KEY", str(caught.exception))

    def test_a_missing_database_password_is_refused_and_named(self):
        # Absent keys stage as '' and the .env uses a bare ${DB_PASS} with
        # no :?, so the service deploys with an empty password and
        # crash-loops on authentication with nothing upstream warning.
        for key in dd.ROLE_PASSWORD_KEYS:
            env = dict(self.GOOD)
            env.pop(key)
            with self.assertRaises(dd.SecretsError) as caught:
                dd.validate_secrets(env)
            self.assertIn(key, str(caught.exception))

    def test_a_blank_database_password_is_refused_too(self):
        env = dict(self.GOOD)
        env["APP_PASS"] = "   "
        with self.assertRaises(dd.SecretsError) as caught:
            dd.validate_secrets(env)
        self.assertIn("APP_PASS", str(caught.exception))

    def test_the_key_is_still_checked_before_the_passwords(self):
        env = dict(self.GOOD)
        env["CRYPTO_MASTER_KEY"] = "a" * 64
        env.pop("DB_PASS")
        with self.assertRaises(dd.SecretsError) as caught:
            dd.validate_secrets(env)
        self.assertIn("CRYPTO_MASTER_KEY", str(caught.exception))

    def test_a_refusal_is_catchable_as_a_refusal(self):
        self.assertTrue(issubclass(dd.SecretsError, dd.Refusal))


class TestFingerprintGuard(unittest.TestCase):
    KEY = base64.b64encode(b"\x01" * 32).decode()
    OTHER = base64.b64encode(b"\x02" * 32).decode()

    def test_matching_fingerprints_are_no_refusal(self):
        fp = dd.key_fingerprint(self.KEY)
        self.assertEqual(dd.fingerprint_refusal(fp, fp, "s.env", "root@h"), "")

    def test_an_empty_remote_fingerprint_is_a_first_deployment(self):
        fp = dd.key_fingerprint(self.KEY)
        self.assertEqual(dd.fingerprint_refusal(fp, "", "s.env", "root@h"), "")
        self.assertEqual(dd.fingerprint_refusal(fp, "\n", "s.env", "root@h"), "")

    def test_a_different_key_refuses_and_names_both_files(self):
        message = dd.fingerprint_refusal(
            dd.key_fingerprint(self.KEY),
            dd.key_fingerprint(self.OTHER),
            "deploy/.secrets.blr.env",
            "root@1.2.3.4",
        )
        self.assertIn("deploy/.secrets.blr.env", message)
        self.assertIn("root@1.2.3.4", message)
        self.assertIn(dd.key_fingerprint(self.KEY), message)
        self.assertIn(dd.key_fingerprint(self.OTHER), message)

    def test_the_refusal_never_contains_either_key(self):
        message = dd.fingerprint_refusal(
            dd.key_fingerprint(self.KEY),
            dd.key_fingerprint(self.OTHER),
            "s.env",
            "root@h",
        )
        self.assertNotIn(self.KEY, message)
        self.assertNotIn(self.OTHER, message)

    def test_trailing_newlines_from_ssh_do_not_look_like_a_mismatch(self):
        fp = dd.key_fingerprint(self.KEY)
        self.assertEqual(dd.fingerprint_refusal(fp, fp + "\n", "s.env", "h"), "")

    def test_the_remote_side_computes_it_with_key_fingerprint_too(self):
        # deploy.sh uses `md5sum | cut -c1-8`. key_fingerprint is sha256, so
        # a shell fingerprint would never match a local one and the guard
        # would refuse every single deployment. Both sides must be this
        # function, run by the copy of this tool that was just pushed.
        command = dd.REMOTE_FINGERPRINT_COMMAND
        self.assertIn("key_fingerprint", command)
        self.assertIn("parse_env_text", command)
        self.assertIn(dd.ENV_PATH, command)
        self.assertNotIn("md5sum", command)
        self.assertNotIn("sha256sum", command)

    def test_a_box_with_no_env_prints_nothing_rather_than_a_hash_of_nothing(self):
        # key_fingerprint('') is a perfectly good hash, and returning it
        # would mismatch every real key and block every first deployment.
        self.assertIn("if k.strip() else ''", dd.REMOTE_FINGERPRINT_COMMAND)


class TestDiskBudgetRefusal(unittest.TestCase):
    def test_deploy_budgets_the_documented_total(self):
        self.assertEqual(dd.deploy_needs(), {dd.INSTALL_PREFIX: 420 * 1000 * 1000})

    def test_a_full_box_is_refused_with_both_numbers(self):
        mounts = dd.parse_df(DF_SINGLE_ROOT_NEARLY_FULL)
        refusal = dd.budget_refusal(
            dd.check_budget(mounts, dd.deploy_needs()), dd.deploy_breakdown()
        )
        self.assertTrue(refusal.startswith("FATAL:"))
        self.assertIn("/", refusal)
        self.assertIn("node_modules", refusal)
        self.assertIn("doctor --disk", refusal)

    def test_a_roomy_box_is_no_refusal_at_all(self):
        mounts = dd.parse_df(DF_SEPARATE)
        self.assertEqual(
            dd.budget_refusal(dd.check_budget(mounts, {"/home": 1024})), ""
        )

    def test_provision_budgets_the_package_install(self):
        needs = dd.provision_needs()
        self.assertEqual(sorted(needs), ["/usr", "/var/cache"])
        self.assertEqual(sum(needs.values()), dd.PROVISION_PACKAGE_BYTES)

    def test_the_dnf_cache_is_charged_to_var_not_to_usr(self):
        # dnf downloads to /var/cache/dnf and the steps clean it afterwards,
        # not during. Charging the whole figure to /usr is right only by
        # accident on a single-root box, and this one has a separate /var --
        # the layout to expect here. It has 102 MiB free against a 300 MB
        # download, and nothing said so before.
        mounts = dd.parse_df(DF_SEPARATE_VAR_TOO_SMALL)
        refusals = dd.check_budget(mounts, dd.provision_needs())
        self.assertEqual(len(refusals), 1, refusals)
        self.assertIn("/var", refusals[0])

    def test_a_single_root_box_still_sees_the_whole_total(self):
        # check_budget sums per mount, so splitting the figure must not make
        # a single-root box think it needs less.
        mounts = dd.parse_df(DF_SINGLE_ROOT_NEARLY_FULL)
        refusals = dd.check_budget(mounts, dd.provision_needs())
        self.assertEqual(len(refusals), 1)
        self.assertIn(dd.human_bytes(dd.PROVISION_PACKAGE_BYTES), refusals[0])


class TestDeployPayload(unittest.TestCase):
    def payload(self):
        return dd.deploy_payload("/repo")

    def test_it_pushes_the_three_bundles_the_dispatch_names(self):
        remotes = [item.remote for item in self.payload()]
        self.assertIn("%s/server/dist" % dd.INSTALL_PREFIX, remotes)
        self.assertIn("%s/admin" % dd.WEB_ROOT, remotes)
        self.assertIn("%s/public-form" % dd.WEB_ROOT, remotes)

    def test_the_admin_bundle_does_not_land_on_the_public_form(self):
        by_remote = dict((item.remote, item.local) for item in self.payload())
        self.assertIn("admin", by_remote["%s/admin" % dd.WEB_ROOT])
        self.assertIn("public-form", by_remote["%s/public-form" % dd.WEB_ROOT])

    def test_the_lockfile_goes_as_a_file_not_a_directory(self):
        kinds = dict((item.remote, item.kind) for item in self.payload())
        self.assertEqual(
            kinds["%s/server/package-lock.json" % dd.INSTALL_PREFIX], "file"
        )
        self.assertEqual(kinds["%s/server/dist" % dd.INSTALL_PREFIX], "dir")

    def test_nothing_is_ever_pushed_over_the_uploads_directory(self):
        # push_dir mirrors by removing the destination first, so a payload
        # entry pointing at uploads -- or at any directory above it --
        # would delete regulatory records.
        for item in self.payload():
            self.assertFalse(
                is_ancestor_of(item.remote, dd.UPLOADS_DIR),
                "%s is %s or contains it" % (item.remote, dd.UPLOADS_DIR),
            )

    def test_every_destination_is_under_a_path_this_tool_owns(self):
        for item in self.payload():
            self.assertTrue(
                item.remote.startswith(dd.INSTALL_PREFIX + "/")
                or item.remote.startswith(dd.WEB_ROOT + "/"),
                item.remote,
            )

    def test_the_three_bundles_are_built_before_anything_is_pushed(self):
        commands = dd.build_commands("/repo")
        self.assertEqual([c for _d, c in commands], ["npm run build"] * 3)
        self.assertEqual(
            [pathlib.PurePath(d).as_posix() for d, _c in commands],
            ["/repo/server", "/repo/apps/admin", "/repo/apps/public-form"],
        )


class TestHealthPoll(unittest.TestCase):
    def test_the_probe_checks_the_unit_and_the_port(self):
        command = dd.health_command()
        self.assertIn("systemctl is-active --quiet %s" % dd.SERVICE, command)
        self.assertIn("127.0.0.1:%d" % dd.APP_PORT, command)

    def test_it_keeps_waiting_until_the_last_attempt(self):
        self.assertEqual(dd.poll_delay(1), dd.HEALTH_INTERVAL_SECONDS)
        self.assertEqual(dd.poll_delay(dd.HEALTH_ATTEMPTS - 1), dd.HEALTH_INTERVAL_SECONDS)

    def test_it_gives_up_after_the_last_attempt(self):
        self.assertIsNone(dd.poll_delay(dd.HEALTH_ATTEMPTS))
        self.assertIsNone(dd.poll_delay(dd.HEALTH_ATTEMPTS + 1))

    def test_it_does_not_sleep_after_the_final_probe(self):
        total = sum(
            dd.poll_delay(n) or 0 for n in range(1, dd.HEALTH_ATTEMPTS + 1)
        )
        self.assertEqual(total, (dd.HEALTH_ATTEMPTS - 1) * dd.HEALTH_INTERVAL_SECONDS)

    def test_the_window_is_deploy_shs_sixty_seconds(self):
        self.assertEqual(dd.HEALTH_ATTEMPTS, 20)
        self.assertEqual(dd.HEALTH_INTERVAL_SECONDS, 3)

    def test_a_slow_start_is_not_reported_as_a_failure(self):
        # The reason this polls at all: on a 1-vCPU box Nest can take well
        # over four seconds to bind, and a one-shot probe calls a working
        # deployment broken.
        ssh = FakeSsh(fail_until=4)  # the fifth probe is the one that answers
        slept = []
        self.assertTrue(dd.poll_health(ssh, io.StringIO(), sleep=slept.append))
        self.assertEqual(len(ssh.commands), 5)
        self.assertEqual(slept, [dd.HEALTH_INTERVAL_SECONDS] * 4)

    def test_an_api_that_never_binds_gives_up_after_twenty(self):
        ssh = FakeSsh(fail_until=10 ** 6)
        slept = []
        self.assertFalse(dd.poll_health(ssh, io.StringIO(), sleep=slept.append))
        self.assertEqual(len(ssh.commands), dd.HEALTH_ATTEMPTS)
        self.assertEqual(len(slept), dd.HEALTH_ATTEMPTS - 1)


class TestRunSteps(unittest.TestCase):
    def test_it_names_every_step_as_it_runs(self):
        ssh = FakeSsh()
        out = io.StringIO()
        dd.run_steps(ssh, [dd.Step("first", "a"), dd.Step("second", "b")], out)
        self.assertIn("first", out.getvalue())
        self.assertIn("second", out.getvalue())
        self.assertEqual(ssh.commands, ["a", "b"])

    def test_it_stops_at_the_first_failure(self):
        ssh = FakeSsh(fail_on="b")
        with self.assertRaises(dd.Refusal):
            dd.run_steps(
                ssh,
                [dd.Step("first", "a"), dd.Step("second", "b"), dd.Step("third", "c")],
                io.StringIO(),
            )
        self.assertEqual(ssh.commands, ["a", "b"])

    def test_the_refusal_names_the_step_and_quotes_the_stderr(self):
        ssh = FakeSsh(fail_on="b", stderr="pg_hba.conf: permission denied")
        with self.assertRaises(dd.Refusal) as caught:
            dd.run_steps(ssh, [dd.Step("second", "b")], io.StringIO())
        self.assertIn("second", str(caught.exception))
        self.assertIn("permission denied", str(caught.exception))

    def test_a_silent_failure_falls_back_to_stdout(self):
        message = dd.step_failure_message("nginx -t", 1, "", "nginx: configuration file failed")
        self.assertIn("nginx -t", message)
        self.assertIn("configuration file failed", message)

    def test_a_failure_that_printed_nothing_still_says_something(self):
        message = dd.step_failure_message("a step", 137, "", "")
        self.assertIn("a step", message)
        self.assertIn("137", message)
        self.assertTrue(message.strip())


class CommandTestCase(unittest.TestCase):
    """Base for the cmd_provision / cmd_deploy tests. No host, no secrets file.

    Everything that would reach the world is replaced: target_ssh (so no
    deploy/.target.env is read), read_secrets (so no secrets file on this
    machine is opened), subprocess.run (so no npm build runs) and
    time.sleep (so a health-poll timeout costs no wall clock). What is left
    is the *order* of the decisions these two functions make, which is the
    region the fail-open fingerprint guard lived in.
    """

    SECRETS = {
        "DB_PASS": "db-pass",
        "APP_PASS": "app-pass",
        "CRYPTO_MASTER_KEY": base64.b64encode(b"\x03" * 32).decode(),
        "EMAIL_PROVIDER": "graph",
        "PRIVACY_MAILBOX": "privacy@example.com",
        "GRAPH_TENANT_ID": "t",
        "GRAPH_CLIENT_ID": "c",
        "GRAPH_CLIENT_SECRET": "s",
    }
    HOST = "root@198.51.100.7"

    def setUp(self):
        self.out = io.StringIO()
        self.err = io.StringIO()
        self.builds = []
        self.slept = []
        self.secrets_read = []
        # Points SECRETS_FILE somewhere that does not exist, so a test that
        # accidentally reaches the real read_secrets fails loudly instead of
        # opening an operator's actual secrets file.
        patcher = unittest.mock.patch.dict(
            os.environ, {"SECRETS_FILE": "/nonexistent/.secrets.test.env"}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def ssh(self, responses=None, **kwargs):
        answers = dict(responses or {})
        answers.setdefault("df -PB1", (0, DF_PLENTY, ""))
        # A box with no .env yet: the probe ran (exit 0) and printed nothing.
        answers.setdefault(dd.REMOTE_FINGERPRINT_COMMAND, (0, "", ""))
        answers.setdefault(dd.health_command(), (0, "", ""))
        return FakeSsh(responses=answers, **kwargs)

    def run_command(self, func, argv, ssh=None, secrets=None):
        ssh = ssh if ssh is not None else self.ssh()

        def fake_subprocess_run(command, **kwargs):
            self.builds.append((command, kwargs.get("cwd")))
            return dd.subprocess.CompletedProcess(command, 0)

        def fake_read_secrets(path):
            self.secrets_read.append(str(path))
            return dict(self.SECRETS if secrets is None else secrets)

        args = dd.build_parser().parse_args(argv)
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                unittest.mock.patch.object(dd, "target_ssh", lambda: (ssh, self.HOST))
            )
            stack.enter_context(
                unittest.mock.patch.object(dd, "read_secrets", fake_read_secrets)
            )
            stack.enter_context(
                unittest.mock.patch.object(dd.subprocess, "run", fake_subprocess_run)
            )
            stack.enter_context(
                unittest.mock.patch.object(dd.time, "sleep", self.slept.append)
            )
            stack.enter_context(unittest.mock.patch.object(sys, "stderr", self.err))
            code = func(args, out=self.out)
        return code, ssh


class TestFingerprintProbeGuard(CommandTestCase):
    """The probe's *return code*, not just what it printed.

    fingerprint_refusal reads an empty remote fingerprint as a first
    deployment, which is right when the box genuinely has no .env. Every way
    the probe can fail looks exactly the same on stdout, so before this the
    guard passed on a box where it had never run -- and the box where it
    cannot run is the RHEL 9 box with Python 3.9, the one it exists for.
    """

    def test_a_clean_probe_is_not_a_refusal(self):
        self.assertEqual(dd.fingerprint_probe_refusal(0, "", "root@h"), "")

    def test_a_failed_probe_names_the_exit_code_and_quotes_the_stderr(self):
        message = dd.fingerprint_probe_refusal(
            127, "bash: python3: command not found", "root@h"
        )
        self.assertIn("127", message)
        self.assertIn("python3: command not found", message)
        self.assertIn("root@h", message)

    def test_a_failed_probe_that_said_nothing_still_refuses(self):
        message = dd.fingerprint_probe_refusal(1, "", "root@h")
        self.assertTrue(message.startswith("FATAL:"))

    def test_an_unimportable_deployer_on_the_box_stops_the_deployment(self):
        # The coupled failure: this file must run on RHEL 9's Python 3.9
        # while being written on a newer one. One 3.10-only construct and
        # `import dsr_deploy` raises on every real box -- unit suite green,
        # --dry-run perfect, guard silently disarmed.
        ssh = self.ssh(
            responses={
                dd.REMOTE_FINGERPRINT_COMMAND: (
                    1,
                    "",
                    "ModuleNotFoundError: No module named 'dsr_deploy'",
                )
            }
        )
        with self.assertRaises(dd.Refusal) as caught:
            self.run_command(dd.cmd_deploy, ["deploy"], ssh=ssh)
        message = str(caught.exception)
        self.assertIn("exit 1", message)
        self.assertIn("ModuleNotFoundError", message)
        # Nothing was built and nothing was pushed over the box's bundles.
        self.assertEqual(self.builds, [])
        self.assertEqual(ssh.pushed_dirs, [])

    def test_a_genuine_first_deployment_still_goes_ahead(self):
        # The other half: exit 0 with no output is a box with no .env, and
        # must stay a first deployment rather than becoming a refusal.
        code, ssh = self.run_command(dd.cmd_deploy, ["deploy"])
        self.assertEqual(code, 0)
        self.assertTrue(ssh.pushed_dirs)


class TestCmdProvision(CommandTestCase):
    """The function this task existed to create, which had no test at all."""

    def test_dry_run_reads_no_secrets_and_never_touches_the_box(self):
        code, ssh = self.run_command(dd.cmd_provision, ["provision", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(self.secrets_read, [])
        self.assertEqual(ssh.events, [])
        self.assertIn("install base packages", self.out.getvalue())

    def test_it_runs_every_provisioning_step_in_order(self):
        code, ssh = self.run_command(dd.cmd_provision, ["provision"])
        self.assertEqual(code, 0)
        expected = [s.command for s in dd.provision_steps()]
        ran = [c for _kind, c in [e for e in ssh.events if e[0] == "run"]]
        for command in expected:
            self.assertIn(command, ran)
        self.assertIn("PROVISION_OK", self.out.getvalue())

    def test_the_budget_is_checked_before_a_single_step_runs(self):
        _code, ssh = self.run_command(dd.cmd_provision, ["provision"])
        first_step = dd.provision_steps()[0].command
        self.assertLess(ssh.index_of_run("df -PB1"), ssh.index_of_run(first_step))

    def test_a_full_box_is_refused_before_anything_is_staged(self):
        ssh = self.ssh(responses={"df -PB1": (0, DF_SINGLE_ROOT_NEARLY_FULL, "")})
        with self.assertRaises(dd.Refusal) as caught:
            self.run_command(dd.cmd_provision, ["provision"], ssh=ssh)
        self.assertIn("FATAL:", str(caught.exception))
        self.assertEqual(ssh.pushed_texts, [])

    def test_the_staged_secrets_are_removed_even_when_a_step_fails(self):
        failing = dd.provision_steps()[1].command
        ssh = self.ssh(responses={failing: (1, "", "No package nginx available")})
        with self.assertRaises(dd.Refusal) as caught:
            self.run_command(dd.cmd_provision, ["provision"], ssh=ssh)
        self.assertIn("No package nginx available", str(caught.exception))
        # The whole reason the removal is in a `finally`: a 0600 file with
        # both role passwords must not outlive a failed run.
        self.assertIn("rm -f %s" % dd.REMOTE_SECRETS, ssh.commands)

    def test_a_transfer_that_dies_mid_push_still_removes_the_secrets_file(self):
        # push_text's remote `cat >` can create the file and then have the
        # transfer fail. With the push outside the try, the finally never
        # ran and a partial 0600 secrets file stayed on the box.
        ssh = self.ssh()

        def exploding_push_text(text, remote, mode=""):
            ssh.events.append(("push_text", remote))
            raise RuntimeError("push_text failed for " + remote + ": lost")

        ssh.push_text = exploding_push_text
        with self.assertRaises(RuntimeError):
            self.run_command(dd.cmd_provision, ["provision"], ssh=ssh)
        self.assertIn("rm -f %s" % dd.REMOTE_SECRETS, ssh.commands)

    def test_it_stages_only_the_two_role_passwords(self):
        _code, ssh = self.run_command(dd.cmd_provision, ["provision"])
        self.assertEqual(len(ssh.pushed_texts), 1)
        text, remote, mode = ssh.pushed_texts[0]
        self.assertEqual(remote, dd.REMOTE_SECRETS)
        self.assertEqual(mode, "600")
        self.assertEqual(sorted(dd.parse_env_text(text)), ["APP_PASS", "DB_PASS"])
        self.assertNotIn("CRYPTO_MASTER_KEY", text)


class TestCmdDeploy(CommandTestCase):
    """The other untested half, and the one the Critical lived in."""

    def test_dry_run_reads_no_secrets_and_never_touches_the_box(self):
        code, ssh = self.run_command(dd.cmd_deploy, ["deploy", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(self.secrets_read, [])
        self.assertEqual(ssh.events, [])
        self.assertEqual(self.builds, [])
        self.assertIn("restart dsr-api", self.out.getvalue())

    def test_a_successful_deployment_runs_every_step_and_reports_ok(self):
        code, ssh = self.run_command(dd.cmd_deploy, ["deploy"])
        self.assertEqual(code, 0)
        ran = [c for _k, c in [e for e in ssh.events if e[0] == "run"]]
        for step in dd.deploy_steps(dict(self.SECRETS)):
            self.assertIn(step.command, ran)
        self.assertIn("DEPLOY_OK", self.out.getvalue())

    def test_both_guards_run_before_the_first_directory_is_mirrored(self):
        # push_dir removes its destination before it unpacks, so a guard
        # that fires after the first push has already cost the box a
        # working install. Both must precede it, and the fingerprint --
        # the unrecoverable one -- must precede the disk check.
        _code, ssh = self.run_command(dd.cmd_deploy, ["deploy"])
        fingerprint = ssh.index_of_run(dd.REMOTE_FINGERPRINT_COMMAND)
        disk = ssh.index_of_run("df -PB1")
        first_push = ssh.first_index_of("push_dir")
        self.assertIsNotNone(first_push)
        self.assertLess(fingerprint, disk)
        self.assertLess(disk, first_push)

    def test_a_mismatched_key_refuses_before_anything_is_pushed(self):
        other = dd.key_fingerprint(base64.b64encode(b"\x09" * 32).decode())
        ssh = self.ssh(
            responses={dd.REMOTE_FINGERPRINT_COMMAND: (0, other + "\n", "")}
        )
        with self.assertRaises(dd.Refusal) as caught:
            self.run_command(dd.cmd_deploy, ["deploy"], ssh=ssh)
        self.assertIn("app_settings", str(caught.exception))
        self.assertEqual(ssh.pushed_dirs, [])
        self.assertEqual(self.builds, [])

    def test_a_failed_build_pushes_nothing(self):
        def failing_build(command, **kwargs):
            self.builds.append((command, kwargs.get("cwd")))
            return dd.subprocess.CompletedProcess(command, 1)

        ssh = self.ssh()
        args = dd.build_parser().parse_args(["deploy"])
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                unittest.mock.patch.object(dd, "target_ssh", lambda: (ssh, self.HOST))
            )
            stack.enter_context(
                unittest.mock.patch.object(
                    dd, "read_secrets", lambda path: dict(self.SECRETS)
                )
            )
            stack.enter_context(
                unittest.mock.patch.object(dd.subprocess, "run", failing_build)
            )
            with self.assertRaises(dd.Refusal) as caught:
                dd.cmd_deploy(args, out=self.out)
        self.assertIn("Nothing was pushed", str(caught.exception))
        self.assertEqual(ssh.pushed_dirs, [])

    def test_the_staged_secrets_are_removed_even_when_a_step_fails(self):
        failing = dd.deploy_steps(dict(self.SECRETS))[3].command
        ssh = self.ssh(responses={failing: (1, "", "relation does not exist")})
        with self.assertRaises(dd.Refusal):
            self.run_command(dd.cmd_deploy, ["deploy"], ssh=ssh)
        self.assertIn("rm -f %s" % dd.REMOTE_SECRETS, ssh.commands)

    def test_an_api_that_never_comes_up_fails_and_shows_the_journal(self):
        ssh = self.ssh(responses={dd.health_command(): (1, "", "")})
        code, ssh = self.run_command(dd.cmd_deploy, ["deploy"], ssh=ssh)
        self.assertEqual(code, 1)
        self.assertIn(dd.JOURNAL_TAIL_COMMAND, ssh.commands)
        self.assertNotIn("DEPLOY_OK", self.out.getvalue())
        self.assertIn("did not come up", self.err.getvalue())
        # It waited the full window rather than giving up on one probe, and
        # it still cleaned the secrets file up on the way out.
        self.assertEqual(len(self.slept), dd.HEALTH_ATTEMPTS - 1)
        self.assertIn("rm -f %s" % dd.REMOTE_SECRETS, ssh.commands)

    def test_a_transfer_that_dies_mid_push_still_removes_the_secrets_file(self):
        # push_text's remote `cat >` can create the file and then have the
        # transfer fail. With the push outside the try, the finally never
        # ran and a partial 0600 secrets file stayed on the box.
        ssh = self.ssh()

        def exploding_push_text(text, remote, mode=""):
            ssh.events.append(("push_text", remote))
            raise RuntimeError("push_text failed for " + remote + ": lost")

        ssh.push_text = exploding_push_text
        with self.assertRaises(RuntimeError):
            self.run_command(dd.cmd_deploy, ["deploy"], ssh=ssh)
        self.assertIn("rm -f %s" % dd.REMOTE_SECRETS, ssh.commands)

    def test_the_deployer_itself_is_pushed_before_the_probe_that_uses_it(self):
        _code, ssh = self.run_command(dd.cmd_deploy, ["deploy"])
        self.assertIn(("push_file", dd.REMOTE_SELF), ssh.events)
        self.assertLess(
            ssh.events.index(("push_file", dd.REMOTE_SELF)),
            ssh.index_of_run(dd.REMOTE_FINGERPRINT_COMMAND),
        )


class TestAtomicWrite(unittest.TestCase):
    def setUp(self):
        self.directory = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.directory), True)
        self.target = self.directory / "pg_hba.conf"
        self.target.write_text("original\n")

    def test_it_replaces_the_content(self):
        dd.atomic_write(str(self.target), "rewritten\n")
        self.assertEqual(self.target.read_text(), "rewritten\n")

    def test_it_creates_a_file_that_did_not_exist(self):
        fresh = self.directory / "new.conf"
        dd.atomic_write(str(fresh), "hello\n")
        self.assertEqual(fresh.read_text(), "hello\n")

    def test_an_interrupted_write_leaves_the_original_whole(self):
        # The point of os.replace: the failure that used to empty
        # pg_hba.conf now leaves it byte-for-byte as it was.
        with unittest.mock.patch("os.replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                dd.atomic_write(str(self.target), "rewritten\n")
        self.assertEqual(self.target.read_text(), "original\n")

    def test_a_failed_write_leaves_no_temporary_file_beside_it(self):
        with unittest.mock.patch("os.replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                dd.atomic_write(str(self.target), "rewritten\n")
        self.assertEqual([p.name for p in self.directory.iterdir()], ["pg_hba.conf"])

    # Mode and ownership are the half of atomic_write nothing reached: this
    # suite runs on Windows, where hasattr(os, "chown") is False and the
    # whole branch is skipped. os.replace swaps inodes, so without it
    # pg_hba.conf comes back root:root 0644 -- PostgreSQL then either
    # refuses to start or the authentication file is world-readable.

    @unittest.skipUnless(hasattr(os, "chown"), "POSIX file modes only")
    def test_the_mode_survives_the_replacement(self):
        os.chmod(str(self.target), 0o640)
        dd.atomic_write(str(self.target), "rewritten\n")
        self.assertEqual(stat.S_IMODE(os.stat(str(self.target)).st_mode), 0o640)

    def test_the_original_uid_and_gid_are_carried_onto_the_replacement(self):
        # Runs everywhere, including where the platform has no ownership at
        # all: os.stat is doctored for this one path so the uid and gid
        # asserted on cannot be whatever the test runner happens to have.
        chowned = []
        chmodded = []
        real_stat = os.stat

        def stat_with_known_owner(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if str(path) == str(self.target):
                fields = list(result)
                fields[0] = 0o100640
                fields[4] = 4242
                fields[5] = 4343
                return os.stat_result(fields)
            return result

        with contextlib.ExitStack() as stack:
            stack.enter_context(
                unittest.mock.patch.object(os, "stat", stat_with_known_owner)
            )
            stack.enter_context(
                unittest.mock.patch.object(
                    os, "chown", lambda *a: chowned.append(a), create=True
                )
            )
            stack.enter_context(
                unittest.mock.patch.object(os, "chmod", lambda *a: chmodded.append(a))
            )
            dd.atomic_write(str(self.target), "rewritten\n")

        self.assertEqual(len(chowned), 1)
        temp_path, uid, gid = chowned[0]
        self.assertEqual((uid, gid), (4242, 4343))
        self.assertEqual(
            pathlib.Path(temp_path).parent.resolve(), self.directory.resolve()
        )
        self.assertEqual(len(chmodded), 1)
        self.assertEqual(chmodded[0][0], temp_path)
        self.assertEqual(stat.S_IMODE(chmodded[0][1]), 0o640)

    def test_a_file_that_did_not_exist_is_not_chowned_to_nothing(self):
        # There is no original to copy from, so neither call may happen --
        # os.stat raising must not become a chown(temp, -1, -1).
        chowned = []
        fresh = self.directory / "brand-new.conf"
        with unittest.mock.patch.object(
            os, "chown", lambda *a: chowned.append(a), create=True
        ):
            dd.atomic_write(str(fresh), "hello\n")
        self.assertEqual(chowned, [])
        self.assertEqual(fresh.read_text(), "hello\n")

    def test_the_temporary_file_is_a_sibling_so_the_rename_stays_atomic(self):
        # os.replace across filesystems is not atomic and can raise, so the
        # temporary file has to live in the target's own directory.
        seen = {}

        real_replace = os.replace

        def record(src, dst):
            seen["src"] = src
            return real_replace(src, dst)

        with unittest.mock.patch("os.replace", side_effect=record):
            dd.atomic_write(str(self.target), "rewritten\n")
        self.assertEqual(
            pathlib.Path(seen["src"]).parent.resolve(), self.directory.resolve()
        )


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


# ---------------------------------------------------------------------------
# doctor
#
# Every fixture below is a hand-written example of what the matching command
# prints on a RHEL 9 box. None of it was captured from a live host: there is
# no host in this test run, by design.
# ---------------------------------------------------------------------------

SEBOOL_OFF = "httpd_can_network_connect --> off\n"
SEBOOL_ON = "httpd_can_network_connect --> on\n"

# One denial, in the shape ausearch prints. This is the log line behind the
# 502 that started all of this.
AVC_DENIAL = (
    "----\n"
    "time->Fri Aug 29 11:04:02 2026\n"
    "type=AVC msg=audit(1756512242.113:271): avc:  denied  { name_connect } "
    'for  pid=1214 comm="nginx" dest=3000 '
    "scontext=system_u:system_r:httpd_t:s0 "
    "tcontext=system_u:object_r:http_port_t:s0 tclass=tcp_socket permissive=0\n"
)

FORBIDDEN_SELINUX_ADVICE = ("setenforce 0", "SELINUX=disabled", "--permissive")

WEBROOT_CONTEXT_OK = "unconfined_u:object_r:httpd_sys_content_t:s0 /var/www/dsr\n"
WEBROOT_CONTEXT_BAD = "unconfined_u:object_r:admin_home_t:s0 /var/www/dsr\n"


def _blob(findings):
    return " ".join(f.title + " " + f.detail + " " + f.fix for f in findings)


class TestSelinuxEvaluator(unittest.TestCase):
    def test_boolean_off_is_a_failure_that_names_the_boolean(self):
        findings = dd.evaluate_selinux("Enforcing", "httpd_can_network_connect --> off", "")
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertTrue(bad)
        self.assertIn("httpd_can_network_connect", bad[0].fix)
        self.assertIn("setsebool -P", bad[0].fix)

    def test_the_fix_is_the_exact_command_to_paste(self):
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_OFF, "")
        fixes = [f.fix for f in findings if f.severity == dd.FAIL]
        self.assertIn("setsebool -P httpd_can_network_connect on", fixes)

    def test_the_failure_names_the_symptom_the_operator_actually_sees(self):
        # The point of the whole mode: 502 plus one nginx log line, and
        # nothing anywhere says the word "SELinux".
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_OFF, "")
        detail = " ".join(f.detail for f in findings if f.severity == dd.FAIL)
        self.assertIn("502", detail)
        self.assertIn("Permission denied while connecting to upstream", detail)

    def test_boolean_on_and_enforcing_is_clean(self):
        findings = dd.evaluate_selinux(
            "Enforcing", "httpd_can_network_connect --> on", "", WEBROOT_CONTEXT_OK
        )
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_permissive_is_a_warning_not_a_recommendation(self):
        findings = dd.evaluate_selinux("Permissive", "httpd_can_network_connect --> on", "")
        warn = [f for f in findings if f.severity == dd.WARN]
        self.assertTrue(warn)
        blob = " ".join(f.fix + f.detail for f in findings)
        self.assertNotIn("setenforce 0", blob)
        self.assertNotIn("SELINUX=disabled", blob)

    def test_a_mislabelled_web_root_is_a_failure_that_names_restorecon(self):
        # 403 on every page, and nothing in the nginx log names SELinux.
        for label in ("admin_home_t", "default_t", "user_home_t"):
            context = "unconfined_u:object_r:%s:s0 /var/www/dsr\n" % label
            findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, "", context)
            bad = [f for f in findings if f.severity == dd.FAIL]
            self.assertEqual(len(bad), 1, label)
            self.assertIn("/var/www/dsr", bad[0].title)
            self.assertIn(label, bad[0].detail)
            self.assertIn("httpd_sys_content_t", bad[0].detail)
            self.assertEqual(bad[0].fix, "restorecon -Rv /var/www/dsr")

    def test_a_correctly_labelled_web_root_is_clean(self):
        context = "unconfined_u:object_r:httpd_sys_content_t:s0 /var/www/dsr\n"
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, "", context)
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))
        self.assertIn("httpd_sys_content_t", _blob(findings))

    def test_an_unreadable_web_root_label_warns_rather_than_passing(self):
        for context in (
            "",
            "ls: cannot access '/var/www/dsr': No such file or directory\n",
            "? /var/www/dsr\n",
        ):
            findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, "", context)
            labels = [f for f in findings if "label of /var/www/dsr" in f.title]
            self.assertEqual([f.severity for f in labels], [dd.WARN], repr(context))

    def test_the_web_root_check_never_echoes_the_command_output(self):
        context = "unconfined_u:object_r:default_t:s0 /var/www/dsr SOMETHING-ELSE\n"
        blob = _blob(dd.evaluate_selinux("Enforcing", SEBOOL_ON, "", context))
        self.assertNotIn("SOMETHING-ELSE", blob)

    def test_disabled_is_told_apart_from_an_unreadable_mode(self):
        # A disabled box needs a relabel and a reboot, not `setenforce 1`:
        # falling through to the generic "could not read the SELinux mode"
        # would hand the operator advice that cannot work.
        findings = dd.evaluate_selinux("Disabled", SEBOOL_ON, "")
        mode = [f for f in findings if "SELinux" in f.title]
        self.assertTrue(mode)
        self.assertEqual(mode[0].severity, dd.WARN)
        self.assertNotIn("could not read", mode[0].title)
        self.assertIn("/.autorelabel", mode[0].fix)
        self.assertIn("reboot", mode[0].fix)
        self.assertNotIn("setenforce 1", mode[0].fix)

    def test_avc_denials_are_surfaced(self):
        avc = "type=AVC msg=audit(1): avc:  denied  { name_connect } for  pid=1 comm=\"nginx\""
        findings = dd.evaluate_selinux("Enforcing", "httpd_can_network_connect --> on", avc)
        self.assertTrue(any("denial" in f.title.lower() for f in findings))

    def test_a_denial_names_the_process_that_was_blocked(self):
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, AVC_DENIAL)
        denials = [f for f in findings if "denial" in f.title.lower()]
        self.assertTrue(denials)
        self.assertNotEqual(denials[0].severity, dd.OK)
        self.assertIn("nginx", denials[0].detail)

    def test_no_denials_is_not_an_error(self):
        # ausearch exits 1 when the audit log is clean, printing nothing or
        # `<no matches>`. Both are the good case.
        for avc in ("", "<no matches>\n"):
            findings = dd.evaluate_selinux(
                "Enforcing", SEBOOL_ON, avc, WEBROOT_CONTEXT_OK
            )
            self.assertTrue(findings)
            self.assertTrue(all(f.severity == dd.OK for f in findings), repr(avc))

    def test_an_unreadable_audit_log_is_not_reported_as_no_denials(self):
        # With stderr folded in, ausearch's own complaint is the answer. An
        # empty read is not evidence that there are no denials.
        for avc in (
            "bash: ausearch: command not found\n",
            "Error opening config file (Permission denied)\n",
            "<no matches>\nError opening /var/log/audit/audit.log (Permission denied)\n",
        ):
            findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, avc)
            audit = [f for f in findings if "audit log" in f.title]
            self.assertEqual([f.severity for f in audit], [dd.WARN], repr(avc))
            self.assertNotIn("no recent SELinux denials", _blob(findings), repr(avc))

    def test_an_unreadable_boolean_warns_rather_than_passing(self):
        findings = dd.evaluate_selinux("Enforcing", "", "")
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_no_finding_anywhere_offers_to_turn_selinux_off(self):
        for mode in ("Enforcing", "Permissive", "Disabled", "", "getenforce: not found"):
            for booleans in (SEBOOL_ON, SEBOOL_OFF, ""):
                for avc in ("", AVC_DENIAL):
                    for webroot in ("", WEBROOT_CONTEXT_OK, WEBROOT_CONTEXT_BAD):
                        blob = _blob(
                            dd.evaluate_selinux(mode, booleans, avc, webroot)
                        )
                        for forbidden in FORBIDDEN_SELINUX_ADVICE:
                            self.assertNotIn(forbidden, blob)


JOURNAL_CLEAN = (
    "Aug 29 11:02:14 dsr-prod systemd[1]: Started DSR portal API.\n"
    "Aug 29 11:02:15 dsr-prod node[4111]: listening on 127.0.0.1:3000\n"
)

JOURNAL_CRASH_LOOP = (
    "Aug 29 11:02:14 dsr-prod systemd[1]: Started DSR portal API.\n"
    "Aug 29 11:02:15 dsr-prod node[4111]: Error: CRYPTO_MASTER_KEY must decode "
    "to 32 bytes\n"
    "Aug 29 11:02:15 dsr-prod systemd[1]: dsr-api.service: Main process exited, "
    "code=exited, status=1/FAILURE\n"
    "Aug 29 11:02:18 dsr-prod systemd[1]: dsr-api.service: Scheduled restart "
    "job, restart counter is at 57.\n"
)


class TestServiceEvaluator(unittest.TestCase):
    def test_a_crash_loop_is_distinguished_from_merely_down(self):
        findings = dd.evaluate_service("activating", "NRestarts=57", "some error")
        self.assertTrue(any("restart" in f.title.lower() for f in findings))
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_active_with_no_restarts_is_clean(self):
        findings = dd.evaluate_service("active", "NRestarts=0", JOURNAL_CLEAN)
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_inactive_is_a_failure(self):
        findings = dd.evaluate_service("inactive", "NRestarts=0", "")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_active_but_restarting_is_still_a_crash_loop(self):
        # systemd reports "active" for most of each three-second cycle, so
        # is-active alone would call this healthy.
        findings = dd.evaluate_service("active", "NRestarts=57", JOURNAL_CRASH_LOOP)
        loop = [f for f in findings if "restart" in f.title.lower()]
        self.assertTrue(loop)
        self.assertEqual(loop[0].severity, dd.FAIL)
        self.assertIn("57", loop[0].title + loop[0].detail)

    def test_down_and_crash_looping_get_different_first_moves(self):
        down = " ".join(f.fix for f in dd.evaluate_service("inactive", "NRestarts=0", ""))
        loop = " ".join(
            f.fix for f in dd.evaluate_service("active", "NRestarts=57", JOURNAL_CRASH_LOOP)
        )
        self.assertNotEqual(down.strip(), loop.strip())
        self.assertIn("systemctl start", down)

    def test_a_known_boot_error_in_the_journal_is_named(self):
        findings = dd.evaluate_service("activating", "NRestarts=12", JOURNAL_CRASH_LOOP)
        blob = _blob(findings)
        self.assertIn("CRYPTO_MASTER_KEY", blob)

    def test_a_journal_line_holding_a_password_is_never_echoed(self):
        journal = (
            "Aug 29 11:02:15 dsr-prod node[4111]: error: connect ECONNREFUSED "
            "postgres://dsr:hunter2@127.0.0.1:5432/dsr\n"
        )
        findings = dd.evaluate_service("inactive", "NRestarts=3", journal)
        self.assertNotIn("hunter2", _blob(findings))

    def test_an_unreadable_journal_is_not_reported_as_no_errors(self):
        # _JOURNAL_ERROR matches none of "command not found", so the
        # complaint would otherwise score zero error lines and read clean.
        for journal in ("", "bash: journalctl: command not found\n"):
            findings = dd.evaluate_service("active", "NRestarts=0", journal)
            journal_findings = [f for f in findings if "journal" in f.title]
            self.assertEqual(
                [f.severity for f in journal_findings], [dd.WARN], repr(journal)
            )
            self.assertNotIn(
                "no errors in the recent journal", _blob(findings), repr(journal)
            )

    def test_a_missing_restart_counter_does_not_crash(self):
        self.assertTrue(dd.evaluate_service("active", "", JOURNAL_CLEAN))


MASTER_KEY_GOOD = base64.b64encode(b"\x01" * 32).decode()
DB_PASSWORD = "n0t-in-a-finding"

ENV_GOOD = (
    "NODE_ENV=production\n"
    "PORT=3000\n"
    "DATABASE_URL=postgres://dsr:" + DB_PASSWORD + "@127.0.0.1:5432/dsr\n"
    "DATABASE_URL_APP=postgres://dsr_app:" + DB_PASSWORD + "@127.0.0.1:5432/dsr\n"
    "CRYPTO_MASTER_KEY=" + MASTER_KEY_GOOD + "\n"
    "COOKIE_SECURE=true\n"
    "EMAIL_PROVIDER=graph\n"
    "PRIVACY_MAILBOX=privacy@example.com\n"
    "GRAPH_TENANT_ID=00000000-0000-0000-0000-000000000000\n"
    "GRAPH_CLIENT_ID=00000000-0000-0000-0000-000000000001\n"
    "GRAPH_CLIENT_SECRET=graph-client-secret-value\n"
)

ENV_GOOD_URL = "postgres://dsr:" + DB_PASSWORD + "@127.0.0.1:5432/dsr"

# Every shape DB_PASS can legally take in deploy/.secrets.env. An operator
# picks that password, so an `@` in it is ordinary -- and a password with an
# `@` also breaks node-postgres URL parsing, which means the box doctor is
# pointed at because the database is unreachable is disproportionately the
# box whose password must not be printed.
DB_URL_SHAPES = (
    ENV_GOOD_URL,
    "postgres://dsr:hun@" + DB_PASSWORD + "@127.0.0.1:5432/dsr",
    "postgres://:" + DB_PASSWORD + "@127.0.0.1:5432/dsr",
    "postgres://dsr@127.0.0.1:5432/dsr?password=" + DB_PASSWORD,
    "postgres://dsr:" + DB_PASSWORD + "@127.0.0.1:notaport/dsr",
)


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
        findings = dd.evaluate_env(self.GOOD, "600")
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

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
        findings = dd.evaluate_env(self.GOOD, "600")
        self.assertTrue(findings)
        for f in findings:
            self.assertNotIn(key, f.title + f.detail + f.fix)

    def test_no_finding_ever_contains_the_database_password(self):
        # The healthy path is the dangerous one: a good box prints the
        # DATABASE_URL finding on every single run.
        for url in DB_URL_SHAPES:
            text = ENV_GOOD.replace(ENV_GOOD_URL, url)
            self.assertIn(url, text, "the fixture substitution missed")
            for mode in ("600", "644"):
                findings = dd.evaluate_env(text, mode)
                self.assertTrue(findings)
                self.assertNotIn(DB_PASSWORD, _blob(findings), url)
            broken = text.replace(MASTER_KEY_GOOD, "a" * 64)
            findings = dd.evaluate_env(broken, "600")
            self.assertTrue(findings)
            self.assertNotIn(DB_PASSWORD, _blob(findings), url)

    def test_the_database_url_finding_still_names_host_port_and_database(self):
        # Redacting by deleting the whole value would pass the test above and
        # tell the operator nothing.
        findings = dd.evaluate_env(ENV_GOOD, "600")
        titles = [f.title for f in findings if f.title.startswith("DATABASE_URL")]
        self.assertEqual(len(titles), 2)
        for title in titles:
            self.assertIn("127.0.0.1:5432/dsr", title)

    def test_a_leading_zero_mode_is_still_owner_only(self):
        findings = dd.evaluate_env(self.GOOD, "0600")
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_a_missing_setting_is_named(self):
        text = "\n".join(
            l for l in self.GOOD.splitlines() if not l.startswith("DATABASE_URL_APP=")
        )
        findings = dd.evaluate_env(text, "600")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("DATABASE_URL_APP", _blob(findings))

    def test_an_unreadable_env_file_is_a_failure_not_a_crash(self):
        findings = dd.evaluate_env("", "")
        self.assertTrue(findings)
        self.assertEqual(dd.exit_code_for(findings), 2)

    def test_the_console_mailer_warns_because_production_refuses_to_send(self):
        text = self.GOOD.replace("EMAIL_PROVIDER=graph", "EMAIL_PROVIDER=console")
        self.assertTrue(any(f.severity == dd.WARN for f in dd.evaluate_env(text, "600")))

    def test_a_missing_graph_credential_is_a_failure_that_names_it(self):
        text = self.GOOD.replace("GRAPH_CLIENT_SECRET=s", "GRAPH_CLIENT_SECRET=")
        findings = dd.evaluate_env(text, "600")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("GRAPH_CLIENT_SECRET", _blob(findings))

    def test_cookie_secure_off_warns_that_the_session_travels_in_clear(self):
        text = self.GOOD + "COOKIE_SECURE=false\n"
        warned = [
            f
            for f in dd.evaluate_env(text, "600")
            if f.severity == dd.WARN and "COOKIE_SECURE" in f.title
        ]
        self.assertTrue(warned)
        self.assertIn("false", warned[0].title)
        self.assertIn("HTTP", warned[0].detail)

    def test_cookie_secure_true_is_not_warned_about(self):
        text = self.GOOD + "COOKIE_SECURE=true\n"
        self.assertEqual(
            [f for f in dd.evaluate_env(text, "600") if f.severity != dd.OK], []
        )

    def test_a_development_node_env_warns(self):
        text = self.GOOD.replace("NODE_ENV=production", "NODE_ENV=development")
        warned = [
            f
            for f in dd.evaluate_env(text, "600")
            if f.severity == dd.WARN and "NODE_ENV" in f.title
        ]
        self.assertTrue(warned)
        self.assertIn("development", warned[0].title)
        self.assertIn("NODE_ENV=production", warned[0].fix)


class TestRedaction(unittest.TestCase):
    def test_a_connection_string_keeps_its_shape_and_loses_its_password(self):
        out = dd.redact_url("postgres://dsr:hunter2@127.0.0.1:5432/dsr")
        self.assertNotIn("hunter2", out)
        self.assertIn("dsr", out)
        self.assertIn("127.0.0.1:5432/dsr", out)

    def test_text_with_no_credentials_is_unchanged(self):
        self.assertEqual(dd.redact_url("nginx -t failed"), "nginx -t failed")

    def test_an_at_sign_inside_the_password_does_not_leave_the_tail_visible(self):
        out = dd.redact_url("postgres://dsr:hun@ter2@127.0.0.1:5432/dsr")
        self.assertNotIn("hun", out)
        self.assertNotIn("ter2", out)
        self.assertEqual(out, "postgres://dsr:***@127.0.0.1:5432/dsr")

    def test_a_url_with_no_username_is_still_redacted(self):
        out = dd.redact_url("postgres://:hunter2@127.0.0.1:5432/dsr")
        self.assertNotIn("hunter2", out)
        self.assertEqual(out, "postgres://:***@127.0.0.1:5432/dsr")

    def test_two_urls_on_one_line_are_both_redacted(self):
        out = dd.redact_url(
            "tried postgres://a:pw1@h1/db then postgres://b:pw2@h2/db"
        )
        self.assertNotIn("pw1", out)
        self.assertNotIn("pw2", out)

    def test_a_credential_free_host_and_port_is_not_over_matched(self):
        # The `@` further along the line must not drag the host:port before
        # it into the match: widening the password class to cross `/` is
        # exactly the mistake that would.
        for text in (
            "conninfo=postgres://127.0.0.1:5432/dsr,notify=root@localhost",
            "psql: could not connect to postgres://127.0.0.1:5432/dsr",
            "nginx: [emerg] bind() to 0.0.0.0:80 failed",
        ):
            self.assertEqual(dd.redact_url(text), text)


class TestDescribeUrl(unittest.TestCase):
    """describe_url never reads the secret, which is why it cannot leak it."""

    def test_it_reports_host_port_and_database(self):
        self.assertEqual(
            dd.describe_url("postgres://dsr:hunter2@127.0.0.1:5432/dsr"),
            "127.0.0.1:5432/dsr",
        )

    def test_no_shape_of_password_survives(self):
        for url in (
            "postgres://dsr:hunter2@127.0.0.1:5432/dsr",
            "postgres://dsr:hun@ter2@127.0.0.1:5432/dsr",
            "postgres://:hunter2@127.0.0.1:5432/dsr",
            "postgres://dsr@127.0.0.1:5432/dsr?password=hunter2",
        ):
            self.assertNotIn("hunter2", dd.describe_url(url), url)
            self.assertNotIn("ter2", dd.describe_url(url), url)

    def test_the_port_defaults_rather_than_disappearing(self):
        self.assertEqual(
            dd.describe_url("postgres://dsr:pw@db.internal/dsr"), "db.internal:5432/dsr"
        )

    def test_something_that_is_not_a_url_is_not_echoed_back(self):
        # A malformed env value can be the bare password itself.
        for value in ("hunter2", "not a url at all", ""):
            self.assertEqual(dd.describe_url(value), "unparseable connection string")

    def test_a_non_numeric_port_is_refused_rather_than_raising(self):
        out = dd.describe_url("postgres://dsr:hunter2@127.0.0.1:notaport/dsr")
        self.assertEqual(out, "unparseable connection string")
        self.assertNotIn("hunter2", out)


DF_ALMOST_FULL = """Filesystem     1B-blocks        Used  Available Capacity Mounted on
/dev/vda1     21474836480 20937965568  536870912      98% /
"""

DF_ROOMY = """Filesystem     1B-blocks        Used  Available Capacity Mounted on
/dev/vda1     53687091200 10737418240 42949672960      20% /
"""

DF_TIGHT = """Filesystem      1B-blocks         Used  Available Capacity Mounted on
/dev/vda1     214748364800 210453397504 4294967296      98% /
"""

DF_SNUG = """Filesystem      1B-blocks         Used  Available Capacity Mounted on
/dev/vda1     214748364800 193273528320 21474836480      90% /
"""

DF_SMALL_WARN = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1      8589934592 6979321856 1610612736      81% /
"""

DF_SMALL_FAIL = """Filesystem     1B-blocks       Used  Available Capacity Mounted on
/dev/vda1      4294967296 3875536896  419430400      90% /
"""

DAY = 86400


class TestDiskEvaluator(unittest.TestCase):
    def test_a_nearly_full_mount_is_not_reported_as_fine(self):
        findings = dd.evaluate_disk(DF_ALMOST_FULL, {})
        self.assertIn(dd.exit_code_for(findings), (1, 2))
        space = [f for f in findings if f.severity in (dd.WARN, dd.FAIL)]
        self.assertTrue(space)
        self.assertIn("/", space[0].title)
        self.assertIn("512.0 MiB", space[0].title + space[0].detail)

    def test_the_percentage_thresholds_separate_warn_from_fail(self):
        # Both of these have gigabytes free, so the absolute-bytes rule
        # cannot fire and only the percentage decides the severity.
        tight = [f for f in dd.evaluate_disk(DF_TIGHT, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in tight], [dd.FAIL])
        snug = [f for f in dd.evaluate_disk(DF_SNUG, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in snug], [dd.WARN])

    def test_a_small_disk_is_judged_on_bytes_not_only_on_percentage(self):
        # Neither disk can be separated by percentage alone: 19% free of
        # 8 GB is a WARN by bytes but comfortably above the 15% line, and
        # 9.8% free of 4 GB is a FAIL by bytes where percentage alone would
        # only warn. The absolute rule is what decides both.
        warn = [f for f in dd.evaluate_disk(DF_SMALL_WARN, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in warn], [dd.WARN])
        fail = [f for f in dd.evaluate_disk(DF_SMALL_FAIL, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in fail], [dd.FAIL])

    def test_a_roomy_mount_is_ok(self):
        findings = dd.evaluate_disk(DF_ROOMY, {})
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_without_a_baseline_it_says_so_rather_than_projecting(self):
        for samples in ({}, {"/": [[1000, 10737418240]]}):
            findings = dd.evaluate_disk(DF_ROOMY, samples)
            baseline = [f for f in findings if "baseline" in (f.title + f.detail).lower()]
            self.assertTrue(baseline, "no baseline finding for %r" % (samples,))
            self.assertEqual(baseline[0].severity, dd.OK)
            # Nothing may claim a number of days from a single reading.
            self.assertNotIn("day", _blob(findings).lower())

    def test_steady_growth_projects_a_deadline_and_warns(self):
        # 4 GB/day against 40 GB free is ten days.
        samples = {"/": [[0, 10737418240 - 4294967296], [DAY, 10737418240]]}
        findings = dd.evaluate_disk(DF_ROOMY, samples)
        growth = [f for f in findings if "day" in f.title.lower()]
        self.assertTrue(growth)
        self.assertEqual(growth[0].severity, dd.WARN)
        self.assertIn("10", growth[0].title)

    def test_flat_usage_is_reported_as_no_growth_not_as_a_deadline(self):
        samples = {"/": [[0, 10737418240], [DAY, 10737418240]]}
        findings = dd.evaluate_disk(DF_ROOMY, samples)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_unreadable_df_output_warns_instead_of_crashing(self):
        findings = dd.evaluate_disk("", {})
        self.assertTrue(findings)
        self.assertTrue(any(f.severity == dd.WARN for f in findings))


# Hand-written examples of what these commands print, not captures: there is
# no RHEL host in this session and inventing a "capture" would be a lie about
# provenance. The shapes are taken from the tools' documented output.
FREE_2G = (
    "               total        used        free      shared  "
    "buff/cache   available\n"
    "Mem:      2061725696   611672064   184623104     8404992  "
    "1265430528  1188945920\n"
    "Swap:     1030862848           0  1030862848\n"
)

FREE_8G = (
    "               total        used        free      shared  "
    "buff/cache   available\n"
    "Mem:      8589934592  1611672064  4184623104     8404992  "
    "2793639424  6588945920\n"
    "Swap:              0           0           0\n"
)

FREE_UNREADABLE = "bash: free: command not found\n"

SWAPON_ZRAM = (
    "NAME       TYPE      SIZE       USED PRIO\n"
    "/dev/zram0 partition 1030862848    0  100\n"
)

SWAPON_SWAPFILE = (
    "NAME      TYPE SIZE       USED PRIO\n"
    "/swapfile file 2147483648    0   -2\n"
)

# What swapon prints on a host with no swap: nothing at all, not even a
# header. That is the condition the check exists to catch, so it must not be
# mistaken for a failed read.
SWAPON_NONE = ""

SWAPON_UNREADABLE = "bash: swapon: command not found\n"

# du prints its children first and the argument last.
DU_OPT_DSR = (
    "4394582016\t/opt/dsr/uploads\n"
    "366477312\t/opt/dsr/server\n"
    "12582912\t/opt/dsr/backups\n"
    "4096\t/opt/dsr/tmp\n"
    "4773646336\t/opt/dsr\n"
)

DU_OPT_DSR_MANY = (
    "4394582016\t/opt/dsr/uploads\n"
    "366477312\t/opt/dsr/server\n"
    "12582912\t/opt/dsr/backups\n"
    "8388608\t/opt/dsr/tmp\n"
    "4194304\t/opt/dsr/spool\n"
    "2097152\t/opt/dsr/state\n"
    "1048576\t/opt/dsr/old\n"
    "4789035008\t/opt/dsr\n"
)

# One unreadable subdirectory, with stderr folded into stdout.
DU_OPT_DSR_PARTIAL = (
    "du: cannot read directory '/opt/dsr/uploads/2026': Permission denied\n"
    "4394582016\t/opt/dsr/uploads\n"
    "366477312\t/opt/dsr/server\n"
    "4773646336\t/opt/dsr\n"
)

DU_DNF_CACHE = "44040192\t/var/cache/dnf\n"
DU_NPM_CACHE = "18874368\t/root/.npm\n"
DU_DNF_CACHE_BIG = "230686720\t/var/cache/dnf\n"
DU_NPM_CACHE_BIG = "62914560\t/root/.npm\n"
DU_ABSENT = "du: cannot access '/root/.npm': No such file or directory\n"
DU_DENIED = "du: cannot read directory '/var/cache/dnf': Permission denied\n"

JOURNAL_USAGE = "Archived and active journals take up 48.0M in the file system.\n"
JOURNAL_USAGE_BIG = "Archived and active journals take up 1.2G in the file system.\n"
JOURNAL_USAGE_UNREADABLE = "bash: journalctl: command not found\n"

ENV_BACKUP_SIZE = "742\n"
ENV_BACKUP_MISSING = "stat: cannot statx '/opt/dsr/server/.env.bak': No such file or directory\n"


class TestMemoryEvaluator(unittest.TestCase):
    def test_the_ram_total_is_reported(self):
        findings = dd.evaluate_memory(FREE_2G, SWAPON_ZRAM)
        self.assertIn("1.9 GiB of RAM", _blob(findings))

    def test_zram_is_reported_as_active_and_clean(self):
        findings = dd.evaluate_memory(FREE_2G, SWAPON_ZRAM)
        self.assertEqual(dd.exit_code_for(findings), 0)
        self.assertIn("zram swap is active", _blob(findings))
        self.assertIn("983.1 MiB", _blob(findings))

    def test_a_swapfile_is_a_warning_that_names_the_file(self):
        # A 2 GiB swapfile is a fifth of this box. Reporting it as "swap is
        # present, fine" is how the disk ends up spent before provisioning.
        findings = dd.evaluate_memory(FREE_2G, SWAPON_SWAPFILE)
        self.assertEqual(dd.exit_code_for(findings), 1)
        blob = _blob(findings)
        self.assertIn("/swapfile", blob)
        self.assertIn("zram", blob)

    def test_no_swap_on_a_small_box_is_a_failure_naming_npm_ci(self):
        findings = dd.evaluate_memory(FREE_2G, SWAPON_NONE)
        self.assertEqual(dd.exit_code_for(findings), 2)
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertEqual(len(bad), 1)
        self.assertIn("no swap", bad[0].title)
        self.assertIn("npm ci", bad[0].detail)
        self.assertIn("systemd-zram-setup", bad[0].fix)

    def test_no_swap_on_a_roomy_box_is_only_a_warning(self):
        # 8 GiB of RAM is not the box npm ci gets killed on.
        findings = dd.evaluate_memory(FREE_8G, SWAPON_NONE)
        self.assertEqual(dd.exit_code_for(findings), 1)

    def test_an_unreadable_free_warns_rather_than_inventing_a_size(self):
        findings = dd.evaluate_memory(FREE_UNREADABLE, SWAPON_ZRAM)
        titles = [f.title for f in findings if f.severity == dd.WARN]
        self.assertIn("could not read the memory table", titles)
        self.assertNotIn("of RAM", _blob(findings))

    def test_an_unreadable_swapon_is_not_reported_as_no_swap(self):
        findings = dd.evaluate_memory(FREE_2G, SWAPON_UNREADABLE)
        self.assertEqual(dd.exit_code_for(findings), 1)
        blob = _blob(findings)
        self.assertIn("could not read the swap table", blob)
        self.assertNotIn("there is no swap", blob)

    def test_nothing_here_ever_recommends_a_swapfile(self):
        for swaps in (SWAPON_ZRAM, SWAPON_SWAPFILE, SWAPON_NONE, SWAPON_UNREADABLE):
            blob = _blob(dd.evaluate_memory(FREE_2G, swaps))
            for forbidden in ("fallocate", "mkswap", "dd if=/dev/zero"):
                self.assertNotIn(forbidden, blob)

    def test_parse_free_reads_the_mem_row_and_not_the_swap_row(self):
        self.assertEqual(dd.parse_free(FREE_2G), {"ram": 2061725696})

    def test_parse_swapon_skips_the_header(self):
        self.assertEqual(
            dd.parse_swapon(SWAPON_ZRAM), [("/dev/zram0", "partition", 1030862848)]
        )
        self.assertEqual(dd.parse_swapon(SWAPON_NONE), [])


class TestLargestDirs(unittest.TestCase):
    def test_the_biggest_directories_are_named_with_sizes(self):
        findings = dd.evaluate_largest_dirs(DU_OPT_DSR)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, dd.OK)
        self.assertIn("/opt/dsr holds 4.4 GiB", findings[0].title)
        self.assertIn("uploads 4.1 GiB", findings[0].detail)
        self.assertIn("server 349.5 MiB", findings[0].detail)

    def test_the_biggest_comes_first(self):
        detail = dd.evaluate_largest_dirs(DU_OPT_DSR)[0].detail
        self.assertLess(detail.index("uploads"), detail.index("server"))
        self.assertLess(detail.index("server"), detail.index("backups"))

    def test_the_listing_is_capped(self):
        detail = dd.evaluate_largest_dirs(DU_OPT_DSR_MANY)[0].detail
        self.assertEqual(detail.count(" MiB") + detail.count(" GiB"), 5)
        self.assertNotIn("old", detail)

    def test_the_prefix_itself_is_the_total_not_a_child(self):
        detail = dd.evaluate_largest_dirs(DU_OPT_DSR)[0].detail
        self.assertNotIn("/opt/dsr ", detail)
        self.assertIn("4.4 GiB", dd.evaluate_largest_dirs(DU_OPT_DSR)[0].title)

    def test_the_uploads_tree_is_named_but_given_no_command(self):
        finding = dd.evaluate_largest_dirs(DU_OPT_DSR)[0]
        self.assertIn("uploads", finding.detail)
        self.assertEqual(finding.fix, "")
        self.assertIn("never reclaimed", finding.detail)

    def test_one_unreadable_subdirectory_does_not_lose_the_measurement(self):
        finding = dd.evaluate_largest_dirs(DU_OPT_DSR_PARTIAL)[0]
        self.assertEqual(finding.severity, dd.OK)
        self.assertIn("uploads 4.1 GiB", finding.detail)
        self.assertNotIn("Permission denied", finding.detail)

    def test_no_output_at_all_warns_rather_than_reporting_an_empty_prefix(self):
        findings = dd.evaluate_largest_dirs("")
        self.assertEqual(dd.exit_code_for(findings), 1)
        self.assertIn("could not measure", findings[0].title)

    def test_is_uploads_path_holds_up(self):
        self.assertTrue(dd.is_uploads_path("/opt/dsr/uploads"))
        self.assertTrue(dd.is_uploads_path("/opt/dsr/uploads/"))
        self.assertTrue(dd.is_uploads_path("/opt/dsr/uploads/2026/07"))
        self.assertFalse(dd.is_uploads_path("/opt/dsr/uploadsx"))
        self.assertFalse(dd.is_uploads_path("/opt/dsr/server"))


class TestReclaimable(unittest.TestCase):
    def healthy(self):
        return dd.evaluate_reclaimable(
            DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_SIZE
        )

    def test_each_source_carries_the_exact_command_that_frees_it(self):
        pairs = [(f.title, f.fix) for f in self.healthy()]
        blob = " | ".join("%s -> %s" % pair for pair in pairs)
        self.assertIn("the dnf package cache is 42.0 MiB -> dnf clean all", blob)
        self.assertIn("the npm cache is 18.0 MiB -> npm cache clean --force", blob)
        self.assertIn(
            "the systemd journal is 48.0 MiB -> journalctl --vacuum-size=100M", blob
        )

    def test_the_total_is_the_sum_of_the_three(self):
        titles = [f.title for f in self.healthy()]
        # 42 MiB + 18 MiB + 48 MiB
        self.assertIn("about 108.0 MiB can be reclaimed without touching data", titles)

    def test_a_small_total_is_not_a_warning(self):
        self.assertEqual(dd.exit_code_for(self.healthy()), 0)

    def test_a_large_total_warns(self):
        findings = dd.evaluate_reclaimable(
            DU_DNF_CACHE_BIG, DU_NPM_CACHE_BIG, JOURNAL_USAGE_BIG, ENV_BACKUP_SIZE
        )
        self.assertEqual(dd.exit_code_for(findings), 1)
        warned = [f for f in findings if f.severity == dd.WARN]
        self.assertEqual(len(warned), 1)
        self.assertIn("can be reclaimed", warned[0].title)

    def test_the_uploads_directory_never_appears_in_a_reclaimable_finding(self):
        # Uploads are the largest thing on the box and the least reclaimable:
        # scanned identity documents held as regulatory records. Naming them
        # under a heading an operator reads as "things you can delete" is how
        # an accident starts.
        for capture in (
            (DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_SIZE),
            (DU_DNF_CACHE_BIG, DU_NPM_CACHE_BIG, JOURNAL_USAGE_BIG, ENV_BACKUP_MISSING),
            (DU_DENIED, DU_ABSENT, JOURNAL_USAGE_UNREADABLE, ""),
        ):
            findings = dd.evaluate_reclaimable(*capture)
            blob = _blob(findings)
            self.assertNotIn(dd.UPLOADS_DIR, blob)
            for finding in findings:
                self.assertNotIn("upload", finding.fix.lower())

    def test_the_database_is_never_offered_as_reclaimable(self):
        blob = _blob(self.healthy())
        for forbidden in ("/var/lib/pgsql", "dropdb", "DROP", "TRUNCATE", "vacuumdb"):
            self.assertNotIn(forbidden, blob)

    def test_an_absent_cache_is_not_an_error_and_frees_nothing(self):
        findings = dd.evaluate_reclaimable(
            DU_DNF_CACHE, DU_ABSENT, JOURNAL_USAGE, ENV_BACKUP_SIZE
        )
        self.assertEqual(dd.exit_code_for(findings), 0)
        titles = [f.title for f in findings]
        self.assertIn("the npm cache is empty or absent", titles)
        # 42 MiB + 48 MiB, with nothing counted for the absent cache.
        self.assertIn("about 90.0 MiB can be reclaimed without touching data", titles)

    def test_an_unreadable_cache_is_not_reported_as_empty(self):
        findings = dd.evaluate_reclaimable(
            DU_DENIED, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_SIZE
        )
        self.assertEqual(dd.exit_code_for(findings), 1)
        warned = [f.title for f in findings if f.severity == dd.WARN]
        self.assertIn("could not measure the dnf package cache", warned)

    def test_an_unreadable_journal_is_not_reported_as_zero(self):
        findings = dd.evaluate_reclaimable(
            DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE_UNREADABLE, ENV_BACKUP_SIZE
        )
        self.assertEqual(dd.exit_code_for(findings), 1)
        self.assertIn("could not measure the journal", _blob(findings))

    def test_the_env_rollback_copy_is_reported_and_never_given_a_command(self):
        rollback = [
            f for f in self.healthy() if "rollback copy" in f.title
        ]
        self.assertEqual(len(rollback), 1)
        self.assertEqual(rollback[0].title, "the .env rollback copy is 742 B")
        self.assertEqual(rollback[0].fix, "")
        self.assertIn("only rollback", rollback[0].detail)

    def test_no_reclaimable_finding_proposes_removing_a_file_by_path(self):
        # Every command here is a cache-clearing subcommand that knows what
        # it owns. An `rm` on a path is how the wrong path gets typed.
        for capture in (
            (DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_SIZE),
            (DU_DENIED, DU_ABSENT, JOURNAL_USAGE_UNREADABLE, ENV_BACKUP_MISSING),
        ):
            blob = _blob(dd.evaluate_reclaimable(*capture))
            for forbidden in ("rm ", "rm -", "unlink ", "shred ", "> /"):
                self.assertNotIn(forbidden, blob)

    def test_a_box_with_no_rollback_copy_says_so(self):
        findings = dd.evaluate_reclaimable(
            DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_MISSING
        )
        self.assertEqual(dd.exit_code_for(findings), 0)
        self.assertIn("no .env rollback copy", _blob(findings))

    def test_the_rollback_copy_is_not_counted_as_reclaimable(self):
        with_backup = [f.title for f in self.healthy()]
        without = [
            f.title
            for f in dd.evaluate_reclaimable(
                DU_DNF_CACHE, DU_NPM_CACHE, JOURNAL_USAGE, ENV_BACKUP_MISSING
            )
        ]
        total = [t for t in with_backup if "can be reclaimed" in t]
        self.assertEqual(total, [t for t in without if "can be reclaimed" in t])

    def test_parse_size_reads_systemds_units(self):
        self.assertEqual(dd.parse_size("48.0M"), 48 * 1024 * 1024)
        self.assertEqual(dd.parse_size("1.2G"), int(1.2 * 1024 ** 3))
        self.assertEqual(dd.parse_size("512K"), 512 * 1024)
        self.assertEqual(dd.parse_size("742"), 742)
        self.assertIsNone(dd.parse_size("no number here"))

    def test_parse_du_skips_what_is_not_a_measurement(self):
        self.assertEqual(
            dd.parse_du(DU_OPT_DSR_PARTIAL),
            [
                (4394582016, "/opt/dsr/uploads"),
                (366477312, "/opt/dsr/server"),
                (4773646336, "/opt/dsr"),
            ],
        )
        self.assertEqual(dd.parse_du(""), [])

    def test_parse_du_needs_both_a_size_and_a_path(self):
        # A line with only one field is not a measurement, and turning it
        # into one invents a directory named after a number.
        self.assertEqual(dd.parse_du("4096\n\n4096\t/opt/dsr\n"),
                         [(4096, "/opt/dsr")])



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

    def test_no_certificate_is_a_warning_and_says_how_to_get_one(self):
        findings = dd.evaluate_tls("", self.NOW)
        self.assertTrue(any(f.severity == dd.WARN for f in findings))
        self.assertIn("enable-tls", _blob(findings))

    def test_the_day_count_is_stated_not_implied(self):
        findings = dd.evaluate_tls("notAfter=Sep 10 00:00:00 2026 GMT", self.NOW)
        self.assertIn("9 days", _blob(findings))

    def test_an_unparseable_date_warns_rather_than_raising(self):
        findings = dd.evaluate_tls("notAfter=whenever", self.NOW)
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_month_names_are_read_without_help_from_the_locale(self):
        # openssl always prints English month abbreviations; strptime("%b")
        # would follow LC_TIME and stop matching under a non-English locale.
        for month, expected_ok in (("Dec", True), ("Sep", False)):
            findings = dd.evaluate_tls(
                "notAfter=%s 10 00:00:00 2026 GMT" % month, self.NOW
            )
            self.assertEqual(all(f.severity == dd.OK for f in findings), expected_ok)


PSQL_ROLES = "dsr\ndsr_app\n"
MIGRATION_FILES = ["0000_init.sql", "0001_rls-audit-seeds.sql", "0002_internal-auth.sql"]
MIGRATIONS_APPLIED = "0000_init.sql\n0001_rls-audit-seeds.sql\n0002_internal-auth.sql\n"

PSQL_AUTH_FAILURE = (
    'psql: error: connection to server at "127.0.0.1", port 5432 failed: '
    'FATAL:  password authentication failed for user "dsr"\n'
)


class TestDatabaseEvaluator(unittest.TestCase):
    def test_both_roles_and_a_current_schema_are_clean(self):
        findings = dd.evaluate_database(PSQL_ROLES, MIGRATIONS_APPLIED, MIGRATION_FILES)
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_a_missing_role_is_a_failure_that_names_it(self):
        findings = dd.evaluate_database("dsr\n", MIGRATIONS_APPLIED, MIGRATION_FILES)
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("dsr_app", _blob(findings))

    def test_pending_migrations_are_a_failure_that_names_the_script(self):
        findings = dd.evaluate_database(
            PSQL_ROLES, "0000_init.sql\n", MIGRATION_FILES
        )
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        blob = _blob(findings)
        self.assertIn("0001_rls-audit-seeds.sql", blob)
        self.assertIn("migrate.mjs", blob)

    def test_a_database_ahead_of_the_code_warns(self):
        findings = dd.evaluate_database(
            PSQL_ROLES, MIGRATIONS_APPLIED + "0003_app-settings.sql\n", MIGRATION_FILES
        )
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_an_auth_failure_points_at_pg_hba_not_at_the_password(self):
        # RHEL's stock pg_hba uses ident on loopback, under which a password
        # authenticates against nothing. That is the cause worth naming.
        findings = dd.evaluate_database(PSQL_AUTH_FAILURE, "", MIGRATION_FILES)
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        blob = _blob(findings)
        self.assertIn("pg_hba", blob)
        self.assertIn("scram-sha-256", blob)

    def test_a_missing_migrations_table_says_migrations_never_ran(self):
        # "some finding is a FAIL and migrate.mjs appears somewhere" is also
        # true of the generic could-not-read branch, so the assertion has to
        # be the distinguishing sentence -- which is the whole point of the
        # branch.
        error = 'ERROR:  relation "schema_migrations" does not exist\n'
        findings = dd.evaluate_database(PSQL_ROLES, error, MIGRATION_FILES)
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertEqual(
            [f.title for f in bad], ["the schema_migrations table does not exist"]
        )
        self.assertIn("No migration has ever run here", bad[0].detail)
        self.assertIn("migrate.mjs", bad[0].fix)

    def test_a_psql_error_that_is_not_the_missing_table_gets_the_generic_message(self):
        error = 'psql: error: FATAL:  database "dsr" does not exist\n'
        findings = dd.evaluate_database(PSQL_ROLES, error, MIGRATION_FILES)
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertEqual([f.title for f in bad], ["could not read the applied migrations"])
        self.assertIn("database \"dsr\" does not exist", bad[0].detail)

    def test_no_files_and_no_applied_rows_is_not_reported_as_healthy(self):
        # Removing the `elif not files:` guard turns this into an OK reading
        # "all 0 migrations are applied". A diagnostic that reports health
        # because it found nothing is worse than one that says nothing.
        findings = dd.evaluate_database(PSQL_ROLES, "", [])
        migrations = [f for f in findings if "migration" in f.title]
        self.assertTrue(migrations)
        self.assertEqual([f.severity for f in migrations], [dd.WARN])
        self.assertEqual(migrations[0].title, "could not list the migration files")
        self.assertNotIn("all 0 migrations are applied", _blob(findings))
        self.assertEqual(dd.exit_code_for(findings), 1)

    def test_a_password_inside_a_psql_error_is_redacted(self):
        error = (
            "psql: error: connection to server on socket failed for "
            "postgres://dsr:hunter2@127.0.0.1:5432/dsr\n"
        )
        self.assertNotIn(
            "hunter2", _blob(dd.evaluate_database(error, error, MIGRATION_FILES))
        )


NGINX_T_OK = (
    "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n"
    "nginx: configuration file /etc/nginx/nginx.conf test is successful\n"
)

NGINX_T_DUPLICATE = (
    "nginx: [emerg] a duplicate default server for 0.0.0.0:80 in "
    "/etc/nginx/conf.d/dsr.conf:11\n"
    "nginx: configuration file /etc/nginx/nginx.conf test failed\n"
)

SS_HEALTHY = """State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process
LISTEN 0      511           0.0.0.0:80          0.0.0.0:*     users:(("nginx",pid=1210,fd=6))
LISTEN 0      511           0.0.0.0:443         0.0.0.0:*     users:(("nginx",pid=1210,fd=8))
LISTEN 0      511         127.0.0.1:3000        0.0.0.0:*     users:(("node",pid=4111,fd=20))
LISTEN 0      244         127.0.0.1:5432        0.0.0.0:*     users:(("postmaster",pid=980,fd=7))
"""

SS_NO_APP = """State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process
LISTEN 0      511           0.0.0.0:80          0.0.0.0:*     users:(("nginx",pid=1210,fd=6))
LISTEN 0      511           0.0.0.0:443         0.0.0.0:*     users:(("nginx",pid=1210,fd=8))
"""

SS_HTTP_ONLY = """State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process
LISTEN 0      511           0.0.0.0:80          0.0.0.0:*     users:(("nginx",pid=1210,fd=6))
LISTEN 0      511         127.0.0.1:3000        0.0.0.0:*     users:(("node",pid=4111,fd=20))
"""

# nginx down entirely: the API is up and bound, but nothing answers on 80.
SS_NO_NGINX = """State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process
LISTEN 0      511         127.0.0.1:3000        0.0.0.0:*     users:(("node",pid=4111,fd=20))
LISTEN 0      244         127.0.0.1:5432        0.0.0.0:*     users:(("postmaster",pid=980,fd=7))
"""


class TestWebEvaluator(unittest.TestCase):
    def test_a_valid_config_and_every_port_is_clean(self):
        findings = dd.evaluate_web(NGINX_T_OK, SS_HEALTHY)
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_a_duplicate_default_server_is_a_failure_that_names_the_cause(self):
        findings = dd.evaluate_web(NGINX_T_DUPLICATE, SS_HEALTHY)
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("default_server", _blob(findings))

    def test_nothing_listening_on_the_app_port_explains_the_502(self):
        findings = dd.evaluate_web(NGINX_T_OK, SS_NO_APP)
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertTrue(bad)
        self.assertIn("3000", _blob(bad))
        self.assertIn("502", _blob(bad))

    def test_nothing_listening_on_80_is_a_failure(self):
        # The portal is unreachable and certbot's HTTP-01 challenge cannot
        # complete either, so this is not the same problem as a missing 443.
        findings = dd.evaluate_web(NGINX_T_OK, SS_NO_NGINX)
        bad = [f for f in findings if f.severity == dd.FAIL]
        self.assertTrue(bad)
        self.assertIn("nginx is not listening on port 80", [f.title for f in bad])
        self.assertEqual(dd.exit_code_for(findings), 2)

    def test_http_only_is_a_warning(self):
        findings = dd.evaluate_web(NGINX_T_OK, SS_HTTP_ONLY)
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_no_ss_output_warns_rather_than_declaring_every_port_shut(self):
        findings = dd.evaluate_web(NGINX_T_OK, "")
        self.assertEqual(dd.exit_code_for(findings), 1)


OS_RELEASE_EL9 = (
    'NAME="Red Hat Enterprise Linux"\n'
    'VERSION="9.4 (Plow)"\n'
    'ID="rhel"\n'
    'VERSION_ID="9.4"\n'
    'PLATFORM_ID="platform:el9"\n'
)


class TestHostEvaluator(unittest.TestCase):
    def test_el9_with_the_right_runtimes_is_clean(self):
        findings = dd.evaluate_host(OS_RELEASE_EL9, "v22.11.0", "psql (PostgreSQL) 16.2")
        self.assertTrue(findings)
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_an_old_node_is_a_failure_that_names_the_version_wanted(self):
        findings = dd.evaluate_host(OS_RELEASE_EL9, "v20.19.0", "psql (PostgreSQL) 16.2")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("22", _blob(findings))

    def test_an_old_postgres_is_a_failure(self):
        findings = dd.evaluate_host(OS_RELEASE_EL9, "v22.11.0", "psql (PostgreSQL) 13.7")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))

    def test_a_host_that_is_not_el9_warns(self):
        findings = dd.evaluate_host(
            'PLATFORM_ID="platform:el8"\n', "v22.11.0", "psql (PostgreSQL) 16.2"
        )
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_a_missing_runtime_is_a_failure_not_a_pass(self):
        findings = dd.evaluate_host(OS_RELEASE_EL9, "", "")
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))


class TestDoctorState(unittest.TestCase):
    def test_a_sample_records_used_bytes_per_mount(self):
        mounts = dd.parse_df(DF_ROOMY)
        samples = dd.update_samples({}, mounts, 1000)
        self.assertEqual(samples["/"], [[1000, 10737418240]])

    def test_samples_accumulate_and_are_trimmed_to_the_last_few(self):
        mounts = dd.parse_df(DF_ROOMY)
        samples = {}
        for t in range(50):
            samples = dd.update_samples(samples, mounts, t, keep=30)
        self.assertEqual(len(samples["/"]), 30)
        self.assertEqual(samples["/"][-1][0], 49)

    def test_a_recorded_pair_feeds_the_projection(self):
        mounts = dd.parse_df(DF_ROOMY)
        samples = dd.update_samples({"/": [[0, 10737418240 - 4294967296]]}, mounts, DAY)
        days = dd.project_days_until_full(samples["/"], mounts[0].free)
        self.assertAlmostEqual(days, 10.0, places=3)

    def test_unreadable_state_is_no_state_rather_than_an_exception(self):
        for text in ("", "not json", "[]", '{"samples": 3}'):
            self.assertEqual(dd.parse_state(text), {})

    def test_state_round_trips_through_json(self):
        samples = {"/": [[1, 2], [3, 4]]}
        self.assertEqual(dd.parse_state(dd.render_state(samples)), samples)


class FakeRunner:
    """Answers collector commands from fixtures; records anything written."""

    def __init__(self, replies):
        self.replies = replies
        self.commands = []
        self.writes = []

    def run(self, command):
        self.commands.append(command)
        for needle, text in self.replies:
            if needle in command:
                return text
        return ""

    def write(self, path, text):
        self.writes.append((path, text))


HEALTHY_REPLIES = [
    ("cat /etc/os-release", OS_RELEASE_EL9),
    ("node -v", "v22.11.0\n"),
    ("psql --version", "psql (PostgreSQL) 16.2\n"),
    ("getenforce", "Enforcing\n"),
    ("getsebool", SEBOOL_ON),
    ("ausearch", ""),
    ("is-active", "active\n"),
    ("NRestarts", "NRestarts=0\n"),
    ("journalctl -u", JOURNAL_CLEAN),
    ("df -PB1", DF_ROOMY),
    ("free -b", FREE_2G),
    ("swapon", SWAPON_ZRAM),
    ("--max-depth", DU_OPT_DSR),
    ("/var/cache/dnf", DU_DNF_CACHE),
    ("/root/.npm", DU_NPM_CACHE),
    ("journalctl --disk-usage", JOURNAL_USAGE),
    ("stat -c %s", ENV_BACKUP_SIZE),
    ("stat -c %a", "600\n"),
    ("cat %s" % dd.ENV_PATH, ENV_GOOD),
    ("pg_roles", PSQL_ROLES),
    ("schema_migrations", MIGRATIONS_APPLIED),
    ("drizzle", "\n".join(MIGRATION_FILES) + "\n"),
    ("openssl x509", "notAfter=Dec 31 00:00:00 2026 GMT\n"),
    ("ls -Zd", WEBROOT_CONTEXT_OK),
    ("nginx -t", NGINX_T_OK),
    ("ss -lntp", SS_HEALTHY),
]

BROKEN_REPLIES = [
    (needle, text) for needle, text in HEALTHY_REPLIES if needle not in ("getsebool", "ausearch")
] + [("getsebool", SEBOOL_OFF), ("ausearch", AVC_DENIAL)]

NOW = 1788220800


class TestDoctorCommands(unittest.TestCase):
    def test_it_runs_the_commands_the_spec_names(self):
        blob = " ".join(command for _name, command in dd.DOCTOR_COMMANDS)
        for expected in (
            "getenforce",
            "getsebool httpd_can_network_connect",
            "ausearch -m avc -ts recent",
            "systemctl is-active",
            "NRestarts",
            "journalctl -u",
            "df -PB1",
            "stat -c",
            "psql -tAc",
            "openssl x509 -enddate -noout",
            "nginx -t",
            "ss -lntp",
            "ls -Zd /var/www/dsr",
            "free -b",
            "swapon --show --bytes",
            "du -xb --max-depth=1 /opt/dsr",
            "du -sb /var/cache/dnf",
            "du -sb /root/.npm",
            "journalctl --disk-usage",
            "stat -c %s /opt/dsr/server/.env.bak",
        ):
            self.assertIn(expected, blob, "doctor never runs %s" % expected)

    def test_the_audit_and_journal_collectors_keep_their_stderr(self):
        # Discarding stderr turns "command not found" into an empty answer,
        # which the evaluators would then read as a clean log.
        commands = dict(dd.DOCTOR_COMMANDS)
        for name in ("avc", "journal"):
            self.assertIn("2>&1", commands[name], name)
            self.assertNotIn("2>/dev/null", commands[name], name)

    def test_not_one_collector_changes_anything(self):
        # The state read is included: it is a command this tool runs on the
        # box, so the guarantee has to cover it too.
        for name, command in dd.DOCTOR_COMMANDS + (("state", dd.STATE_READ_COMMAND),):
            for forbidden in (
                "systemctl restart",
                "systemctl start",
                "systemctl stop",
                "systemctl reload",
                "setsebool",
                "setenforce",
                "rm -",
                "chmod",
                "chown",
                "dnf install",
                "INSERT",
                "UPDATE ",
                "DELETE",
                "DROP",
                "CREATE",
                "certbot",
                "migrate.mjs",
                # du takes none of these, but find-shaped muscle memory
                # writes them anyway, and this tree is identity documents.
                "-delete",
                "--delete",
                "-exec",
                "-execdir",
                "truncate",
                "shred",
                "unlink",
                "mv ",
                "clean all",
                "cache clean",
                "--vacuum",
                "-X POST",
                "-X PUT",
                "--data",
                "-o /dev/null -X",
            ):
                self.assertNotIn(forbidden, command, "%s would change the box" % name)

    def test_the_du_collectors_carry_only_measuring_flags(self):
        # The blanket sweep above catches flags somebody typed. This one
        # catches flags nobody thought of, by refusing everything that is
        # not on the list -- and asserts the du collectors are still there,
        # so deleting them cannot make this pass.
        allowed = ("-x", "-b", "-s", "-sb", "-xb", "-bs", "--max-depth=1")
        seen = []
        for name, command in dd.DOCTOR_COMMANDS:
            words = command.split(" 2>")[0].split()
            if words[0] != "du":
                continue
            seen.append(name)
            for token in words[1:]:
                if token.startswith("-"):
                    self.assertIn(token, allowed, "%s: %s" % (name, token))
        self.assertEqual(
            sorted(seen), ["dnf_cache", "largest_dirs", "npm_cache"]
        )


class TestDoctorAssembly(unittest.TestCase):
    def healthy(self):
        return dd.collect(FakeRunner(HEALTHY_REPLIES))

    def test_a_healthy_box_produces_findings_and_none_of_them_are_bad(self):
        findings = dd.assemble_findings(self.healthy(), {}, NOW)
        self.assertTrue(findings)
        bad = [(f.group, f.title, f.detail) for f in findings if f.severity != dd.OK]
        self.assertEqual(bad, [])
        self.assertEqual(dd.exit_code_for(findings), 0)

    def test_the_new_host_and_disk_checks_reach_the_report(self):
        # An evaluator with passing unit tests that nothing calls is a check
        # that does not exist.
        titles = [f.title for f in dd.assemble_findings(self.healthy(), {}, NOW)]
        for expected in (
            "the host has 1.9 GiB of RAM",
            "zram swap is active (983.1 MiB)",
            "/opt/dsr holds 4.4 GiB",
            "the dnf package cache is 42.0 MiB",
            "the npm cache is 18.0 MiB",
            "the systemd journal is 48.0 MiB",
            "the .env rollback copy is 742 B",
            "about 108.0 MiB can be reclaimed without touching data",
        ):
            self.assertIn(expected, titles)

    def test_every_group_the_cli_can_filter_on_actually_reports(self):
        groups = {f.group for f in dd.assemble_findings(self.healthy(), {}, NOW)}
        self.assertEqual(set(dd.DOCTOR_GROUPS), groups)

    def test_the_selinux_boolean_is_found_end_to_end(self):
        findings = dd.assemble_findings(dd.collect(FakeRunner(BROKEN_REPLIES)), {}, NOW)
        fixes = [f.fix for f in findings if f.severity == dd.FAIL]
        self.assertIn("setsebool -P httpd_can_network_connect on", fixes)
        self.assertEqual(dd.exit_code_for(findings), 2)

    def test_no_finding_anywhere_recommends_something_destructive(self):
        for replies in (HEALTHY_REPLIES, BROKEN_REPLIES):
            blob = _blob(dd.assemble_findings(dd.collect(FakeRunner(replies)), {}, NOW))
            for forbidden in FORBIDDEN_SELINUX_ADVICE + ("rm -rf", "DROP TABLE", "dropdb"):
                self.assertNotIn(forbidden, blob)

    def test_a_broken_box_still_reports_every_group(self):
        # One failure must not stop the rest of the checks from running.
        findings = dd.assemble_findings(dd.collect(FakeRunner([])), {}, NOW)
        self.assertEqual(set(dd.DOCTOR_GROUPS), {f.group for f in findings})


class TestCmdDoctor(unittest.TestCase):
    def run_doctor(self, argv, replies=HEALTHY_REPLIES):
        args = dd.build_parser().parse_args(argv)
        runner = FakeRunner(replies)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = dd.cmd_doctor(args, runner, now_epoch=NOW)
        return code, buffer.getvalue(), runner

    def test_a_healthy_box_prints_a_report_and_exits_zero(self):
        code, text, _runner = self.run_doctor(["doctor", "--no-state"])
        self.assertEqual(code, 0)
        self.assertIn("selinux", text)
        self.assertIn("All checks passed.", text)

    def test_a_broken_box_exits_two_and_prints_the_setsebool_line(self):
        code, text, _runner = self.run_doctor(["doctor", "--no-state"], BROKEN_REPLIES)
        self.assertEqual(code, 2)
        self.assertIn("setsebool -P httpd_can_network_connect on", text)

    def test_a_group_filter_narrows_the_report(self):
        code, text, _runner = self.run_doctor(["doctor", "--no-state", "--selinux"])
        self.assertIn("[selinux]", text)
        self.assertNotIn("[disk]", text)
        self.assertEqual(code, 0)
        self.assertIn("All selinux checks passed.", text)
        self.assertNotIn("All checks passed.", text)

    def test_a_filtered_run_never_claims_the_whole_box_is_healthy(self):
        # This box has a SELinux FAIL. Exit 0 is defensible for a disk-scoped
        # cron check; the word "All" is not -- it asserts something about the
        # whole box that this run never established.
        code, text, _runner = self.run_doctor(
            ["doctor", "--no-state", "--disk"], BROKEN_REPLIES
        )
        self.assertEqual(code, 0)
        self.assertIn("[disk]", text)
        self.assertNotIn("[selinux]", text)
        self.assertIn("All disk checks passed.", text)
        self.assertNotIn("All checks passed.", text)

    def test_two_filters_name_both_groups(self):
        _code, text, _runner = self.run_doctor(
            ["doctor", "--no-state", "--disk", "--web"]
        )
        self.assertIn("All disk and web checks passed.", text)

    def test_an_unfiltered_clean_run_still_says_all_checks_passed(self):
        _code, text, _runner = self.run_doctor(["doctor", "--no-state"])
        self.assertIn("All checks passed.", text)

    def test_it_records_a_sample_by_default(self):
        _code, _text, runner = self.run_doctor(["doctor"])
        self.assertEqual([path for path, _text in runner.writes], [dd.STATE_PATH])
        self.assertIn("/", dd.parse_state(runner.writes[0][1]))

    def test_no_state_writes_nothing_at_all(self):
        _code, _text, runner = self.run_doctor(["doctor", "--no-state"])
        self.assertEqual(runner.writes, [])


if __name__ == "__main__":
    unittest.main()
