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
        # format_help() on the top-level parser never lists a subparser's own
        # arguments, so asserting against it proves nothing -- --remote must
        # be checked against the "doctor" subcommand's own help text, which
        # is where argparse.SUPPRESS actually has an effect.
        subparsers_action = dd.build_parser()._subparsers._group_actions[0]
        doctor_help = subparsers_action.choices["doctor"].format_help()
        self.assertNotIn("--remote", doctor_help)

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
            if (
                line.startswith("host")
                and "replication" not in line
                and ("127.0.0.1/32" in line or "::1/128" in line)
            ):
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


if __name__ == "__main__":
    unittest.main()
