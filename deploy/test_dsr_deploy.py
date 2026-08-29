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
