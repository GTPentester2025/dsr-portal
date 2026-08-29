from __future__ import annotations

import base64
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


if __name__ == "__main__":
    unittest.main()
