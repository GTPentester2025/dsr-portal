from __future__ import annotations

import base64
import contextlib
import io
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
import unittest.mock

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

    def test_the_initdb_step_joins_its_enable_with_and(self):
        step = [s for s in dd.provision_steps() if "initdb" in s.name][0]
        self.assertIn("&& systemctl enable --now postgresql", step.command)

    def test_every_config_rewrite_is_written_atomically(self):
        # A truncating write is the failure atomic_write exists to remove;
        # a step that reached for p.write_text again would reintroduce it.
        rewrites = [s for s in dd.provision_steps() if "dsr_deploy as d" in s.command]
        self.assertEqual(len(rewrites), 2)
        for step in rewrites:
            self.assertIn("atomic_write", step.command, step.name)
            self.assertNotIn("write_text", step.command, step.name)

    def test_render_plan_numbers_the_steps_and_shows_commands(self):
        text = dd.render_plan([dd.Step("do a thing", "echo hi")])
        self.assertIn("do a thing", text)
        self.assertIn("echo hi", text)
        self.assertIn("1", text)


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

    def test_a_denial_names_the_process_that_was_blocked(self):
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, AVC_DENIAL)
        denials = [f for f in findings if "denial" in f.title.lower()]
        self.assertTrue(denials)
        self.assertNotEqual(denials[0].severity, dd.OK)
        self.assertIn("nginx", denials[0].detail)

    def test_no_denials_is_not_an_error(self):
        # ausearch exits 1 and prints nothing to stdout when the audit log is
        # clean, which is the good case.
        findings = dd.evaluate_selinux("Enforcing", SEBOOL_ON, "")
        self.assertTrue(all(f.severity == dd.OK for f in findings))

    def test_an_unreadable_boolean_warns_rather_than_passing(self):
        findings = dd.evaluate_selinux("Enforcing", "", "")
        self.assertTrue(any(f.severity == dd.WARN for f in findings))

    def test_no_finding_anywhere_offers_to_turn_selinux_off(self):
        for mode in ("Enforcing", "Permissive", "Disabled", "", "getenforce: not found"):
            for booleans in (SEBOOL_ON, SEBOOL_OFF, ""):
                for avc in ("", AVC_DENIAL):
                    blob = _blob(dd.evaluate_selinux(mode, booleans, avc))
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
        findings = dd.evaluate_service("active", "NRestarts=0", "")
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

    def test_no_finding_ever_contains_the_database_password(self):
        for mode in ("600", "644"):
            self.assertNotIn(DB_PASSWORD, _blob(dd.evaluate_env(ENV_GOOD, mode)))
        broken = ENV_GOOD.replace(MASTER_KEY_GOOD, "a" * 64)
        self.assertNotIn(DB_PASSWORD, _blob(dd.evaluate_env(broken, "600")))

    def test_a_leading_zero_mode_is_still_owner_only(self):
        self.assertTrue(all(f.severity == dd.OK for f in dd.evaluate_env(self.GOOD, "0600")))

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


class TestRedaction(unittest.TestCase):
    def test_a_connection_string_keeps_its_shape_and_loses_its_password(self):
        out = dd.redact_url("postgres://dsr:hunter2@127.0.0.1:5432/dsr")
        self.assertNotIn("hunter2", out)
        self.assertIn("dsr", out)
        self.assertIn("127.0.0.1:5432/dsr", out)

    def test_text_with_no_credentials_is_unchanged(self):
        self.assertEqual(dd.redact_url("nginx -t failed"), "nginx -t failed")


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
        self.assertIn("512.0 MB", space[0].title + space[0].detail)

    def test_the_percentage_thresholds_separate_warn_from_fail(self):
        # Both of these have gigabytes free, so the absolute-bytes rule
        # cannot fire and only the percentage decides the severity.
        tight = [f for f in dd.evaluate_disk(DF_TIGHT, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in tight], [dd.FAIL])
        snug = [f for f in dd.evaluate_disk(DF_SNUG, {}) if f.severity != dd.OK]
        self.assertEqual([f.severity for f in snug], [dd.WARN])

    def test_a_small_disk_is_judged_on_bytes_not_only_on_percentage(self):
        # Both of these are comfortable by percentage and cramped in
        # absolute terms: an npm install needs room, not a share.
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
        error = 'ERROR:  relation "schema_migrations" does not exist\n'
        findings = dd.evaluate_database(PSQL_ROLES, error, MIGRATION_FILES)
        self.assertTrue(any(f.severity == dd.FAIL for f in findings))
        self.assertIn("migrate.mjs", _blob(findings))

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
    ("journalctl", JOURNAL_CLEAN),
    ("df -PB1", DF_ROOMY),
    ("stat -c", "600\n"),
    ("cat %s" % dd.ENV_PATH, ENV_GOOD),
    ("pg_roles", PSQL_ROLES),
    ("schema_migrations", MIGRATIONS_APPLIED),
    ("drizzle", "\n".join(MIGRATION_FILES) + "\n"),
    ("openssl x509", "notAfter=Dec 31 00:00:00 2026 GMT\n"),
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
        ):
            self.assertIn(expected, blob, "doctor never runs %s" % expected)

    def test_not_one_collector_changes_anything(self):
        for name, command in dd.DOCTOR_COMMANDS:
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
            ):
                self.assertNotIn(forbidden, command, "%s would change the box" % name)


class TestDoctorAssembly(unittest.TestCase):
    def healthy(self):
        return dd.collect(FakeRunner(HEALTHY_REPLIES))

    def test_a_healthy_box_produces_findings_and_none_of_them_are_bad(self):
        findings = dd.assemble_findings(self.healthy(), {}, NOW)
        self.assertTrue(findings)
        bad = [(f.group, f.title, f.detail) for f in findings if f.severity != dd.OK]
        self.assertEqual(bad, [])
        self.assertEqual(dd.exit_code_for(findings), 0)

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
        _code, text, _runner = self.run_doctor(["doctor", "--no-state", "--selinux"])
        self.assertIn("[selinux]", text)
        self.assertNotIn("[disk]", text)

    def test_it_records_a_sample_by_default(self):
        _code, _text, runner = self.run_doctor(["doctor"])
        self.assertEqual([path for path, _text in runner.writes], [dd.STATE_PATH])
        self.assertIn("/", dd.parse_state(runner.writes[0][1]))

    def test_no_state_writes_nothing_at_all(self):
        _code, _text, runner = self.run_doctor(["doctor", "--no-state"])
        self.assertEqual(runner.writes, [])


if __name__ == "__main__":
    unittest.main()
