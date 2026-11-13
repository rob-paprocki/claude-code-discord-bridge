"""Tests of the release tooling: pattern checks, changelog tools and the changelog check."""
import contextlib
import importlib.util
import io
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.dont_write_bytecode = True     # a copy that is not a git checkout must stay clean


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


check_repo = load("check_repo", os.path.join(HERE, "check_repo.py"))
build = load("build_public", os.path.join(ROOT, "scripts", "release", "build_public.py"))
changelog = load("changelog", os.path.join(ROOT, "scripts", "release", "changelog.py"))
changelog_check = load("changelog_check", os.path.join(ROOT, "scripts", "release", "changelog_check.py"))
publish = load("publish_public", os.path.join(ROOT, "scripts", "release", "publish_public.py"))

# The tests' own git calls ignore the owner's git config (signing, hooks, templates): the
# suite also runs on the owner's Mac right before a publish.
ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
           GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com",
           GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")


def IP(*parts):
    return ".".join(parts)


def git(repo, *args):
    return subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True,
                          check=True, env=ENV).stdout.strip()


def make_repo(files, message="init"):
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    add_commit(d, files, message)
    return d


def add_commit(d, files, message):
    for path, text in files.items():
        p = os.path.join(d, path)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", message)


class PatternTests(unittest.TestCase):
    def kinds(self, text):
        return [k for _, k in check_repo.scan_text(text)]

    def test_allowed_values(self):
        self.assertEqual(self.kinds("gw 192.168.100.1, dns 1.1.1.1, lo 127.0.0.1, doc 203.0.113.9\n"
                                    "mac 00:00:5E:00:53:0a, mail admin@example.com, x@y.invalid\n"
                                    "me hi@rpaprocki.com git@github.com\n"
                                    "bcast 255.255.255.255 v6 2001:db8::1 ::1\n"
                                    "time 01:02:52 version 1.2.3 port 8006"), [])

    def test_disallowed_values(self):
        # The "bad" samples are assembled at runtime so that no disallowed value
        # appears literally in this (public) file.
        self.assertEqual(self.kinds(IP("10", "1", "2", "3")), ["IP address"])         # private
        self.assertEqual(self.kinds(IP("100", "64", "1", "2")), ["IP address"])       # CGNAT
        self.assertEqual(self.kinds(IP("8", "8", "4", "5")), ["IP address"])          # public
        self.assertEqual(self.kinds(":".join(["fd12", "3456", "789a", "", "1"])), ["IPv6 address"])
        self.assertEqual(self.kinds(":".join(["e0", "51", "d8", "00", "11", "22"])), ["MAC address"])
        self.assertEqual(self.kinds("me" + "@" + "mail-provider.com"), ["email address"])

    def test_report_never_contains_the_value(self):
        bad = IP("10", "20", "30", "40")
        d = make_repo({"a.txt": "secret %s here\n" % bad, "private/notes.md": bad + "\n"})
        problems = check_repo.check(d)
        self.assertEqual(problems, ["a.txt:1: IP address not allowed in public files"])   # private/ skipped
        self.assertNotIn(bad, "".join(problems))

    def test_node_modules_skipped(self):
        bad = IP("10", "20", "30", "40")
        d = make_repo({"a.txt": "ok\n", "worker/node_modules/x/y.js": bad + "\n"})
        self.assertEqual(check_repo.check(d), [])
        plain = tempfile.mkdtemp()                       # not a git checkout: walks the tree
        os.makedirs(os.path.join(plain, "node_modules"))
        with open(os.path.join(plain, "node_modules", "z.js"), "w") as f:
            f.write(bad + "\n")
        self.assertEqual(check_repo.check(plain), [])

    def test_main_exit_codes(self):
        d = make_repo({"a.txt": "ok\n"})
        self.assertEqual(check_repo.main(["check_repo.py", d]), 0)
        add_commit(d, {"b.txt": IP("10", "1", "1", "1") + "\n"}, "bad")
        self.assertEqual(check_repo.main(["check_repo.py", d]), 1)

    def test_email_allow_list_is_exact(self):
        self.assertEqual(self.kinds("41898282+github-actions[bot]@users.noreply.github.com "
                                    "hi@rpaprocki.com git@github.com a@sub.example.com"), [])
        for addr in ("noreply" + "@github.com", "a" + "@example.org", "a" + "@example.net",
                     "someone[x]" + "@mail-provider.com"):
            self.assertEqual(self.kinds(addr), ["email address"], addr)

    def test_ip_allow_list_is_exact(self):
        self.assertEqual(self.kinds("1.1.1.1 8.8.8.8 0.0.0.0"), [])
        for ip in (IP("9", "9", "9", "9"), IP("1", "0", "0", "1"), IP("8", "8", "4", "4")):
            self.assertEqual(self.kinds(ip), ["IP address"], ip)

    def test_unparsable_four_octet_value_is_a_finding(self):
        self.assertEqual(self.kinds(IP("010", "001", "002", "003")), ["IP address"])
        self.assertEqual(self.kinds(IP("300", "1", "1", "1")), ["IP address"])

    def test_value_in_file_name_is_never_printed(self):
        name = "a" + "@mail-provider.com.txt"
        d = make_repo({name: "fine\n", "z.txt": "ok\n"})
        problems = check_repo.check(d)
        self.assertEqual(problems, ["file #1 (in sorted order): email address in the file name"])
        self.assertNotIn("mail-provider", "".join(problems))
        with open(os.path.join(d, name), "wb") as f:
            f.write(b"\xff\xfe")
        problems = check_repo.check(d)
        self.assertNotIn("mail-provider", "".join(problems))
        self.assertTrue(any("not UTF-8" in p for p in problems))

    def test_bad_root_and_empty_tree_fail(self):
        self.assertEqual(check_repo.main(["check_repo.py", "/nonexistent/dir"]), 1)
        self.assertEqual(check_repo.main(["check_repo.py", tempfile.mkdtemp()]), 1)

    def test_unreadable_tracked_entries_are_findings(self):
        d = make_repo({"a.txt": "ok\n", "sub/b.txt": "ok\n"})
        os.symlink("sub", os.path.join(d, "dirlink"))
        git(d, "add", "-A")
        git(d, "commit", "-q", "-m", "link")
        self.assertEqual(check_repo.check(d), ["dirlink: not a readable regular file"])
        os.unlink(os.path.join(d, "dirlink"))               # deleted, uncommitted: skipped
        self.assertEqual(check_repo.check(d), [])

    def test_pycache_hides_only_bytecode(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "__pycache__"))
        with open(os.path.join(d, "__pycache__", "x.cpython-313.pyc"), "wb") as f:
            f.write(b"\xff\xfe")
        with open(os.path.join(d, "__pycache__", "note.txt"), "w") as f:
            f.write("me" + "@mail-provider.com\n")
        with open(os.path.join(d, "a.txt"), "w") as f:
            f.write("ok\n")
        self.assertEqual(check_repo.check(d),
                         ["__pycache__/note.txt:1: email address not allowed in public files"])

    def test_strict_mode_skips_nothing(self):
        # The build checks its output in strict mode: bytecode and node_modules there would be
        # published, so they are checked like everything else.
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "__pycache__"))
        os.makedirs(os.path.join(d, "node_modules"))
        with open(os.path.join(d, "__pycache__", "m.cpython-39.pyc"), "wb") as f:
            f.write(b"\xff\xfe")
        with open(os.path.join(d, "node_modules", "z.js"), "w") as f:
            f.write(IP("10", "20", "30", "40") + "\n")
        self.assertEqual(check_repo.check(d), [])                     # a working tree: skipped
        self.assertEqual(check_repo.check(d, strict=True),
                         ["__pycache__/m.cpython-39.pyc: not UTF-8 text",
                          "node_modules/z.js:1: IP address not allowed in public files"])

    def test_this_repo_is_clean(self):
        self.assertEqual(check_repo.check(ROOT), [])


CL = """# Changelog

## [Unreleased]

**Upgrading:** nothing to do.

### Fixed
- a bug

## [1.2.3] - 2026-01-01

**Upgrading:** nothing to do.

### Added
- things
"""


class BuildPublic(unittest.TestCase):
    WORD = "zz-secret-word-zz"          # a dummy built at runtime; never a real word-list entry

    def setUp(self):
        self.wl = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
        self.wl.write(self.WORD + "\n")
        self.wl.close()
        self.addCleanup(os.unlink, self.wl.name)
        self.pat = build.load_wordlist(self.wl.name)

    def mk(self, files):
        files = dict(files)
        files.setdefault("private/public-exclude.txt", "# nothing extra\n")
        return make_repo(files)

    def out(self):
        return os.path.join(tempfile.mkdtemp(), "copy")

    def test_private_removed_and_excludes_honoured(self):
        d = self.mk({"README.md": "hi [lic](LICENSE)\n", "LICENSE": "MIT\n",
                       "private/plan.md": "mine\n",
                       "private/public-exclude.txt": "# header\n.github/workflows/cut.yml\n",
                       ".github/workflows/cut.yml": "private workflow\n"})
        files = build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertEqual(files, ["LICENSE", "README.md"])

    def test_archive_ignores_owner_git_config(self):
        # A global core.autocrlf=true makes `git archive` write CRLF; the copy must not change.
        d = make_repo({"README.md": "line one\nline two\n", "private/public-exclude.txt": "# x\n"})
        cfg = os.path.join(tempfile.mkdtemp(), "gitconfig")
        with open(cfg, "w") as f:
            f.write("[core]\n\tautocrlf = true\n")
        saved = {k: os.environ.get(k) for k in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")}
        os.environ["GIT_CONFIG_GLOBAL"] = cfg
        os.environ.pop("GIT_CONFIG_NOSYSTEM", None)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)
        out = self.out()
        build.archive("HEAD", out, repo=d)
        with open(os.path.join(out, "README.md"), "rb") as f:
            self.assertEqual(f.read(), b"line one\nline two\n")

    def test_word_in_file_name_fails_without_printing_it(self):
        d = self.mk({"docs/a.md": "nothing\n", "tests/fixture-%s.json" % self.WORD: "{}\n"})
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        msg = str(e.exception)
        self.assertNotIn(self.WORD, msg)
        self.assertNotIn("fixture", msg)
        self.assertIn("file #2 (in sorted order)", msg)

    def test_word_in_content_and_message(self):
        d = self.mk({"a.md": "serial %s\n" % self.WORD.upper()})
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertNotIn(self.WORD, str(e.exception).lower())
        d2 = self.mk({"a.md": "fine\n"})
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, ["release for " + self.WORD], repo=d2)
        self.assertNotIn(self.WORD, str(e.exception))

    def test_empty_or_missing_wordlist_fails(self):
        with open(self.wl.name, "w") as f:
            f.write("\n# only a comment\n")
        with self.assertRaises(build.PublishError):
            build.load_wordlist(self.wl.name)
        with self.assertRaises(build.PublishError):
            build.load_wordlist("/nonexistent/wordlist")
        with self.assertRaises(build.PublishError):
            build.load_wordlist(None, None)
        with self.assertRaises(build.PublishError):
            build.load_wordlist(None, "  \n")

    def test_non_utf8_fails(self):
        d = self.mk({"a.md": "x\n"})
        with open(os.path.join(d, "blob.bin"), "wb") as f:
            f.write(b"\xff\xfe\x00bad")
        git(d, "add", "-A")
        git(d, "commit", "-q", "-m", "bin")
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertIn("UTF-8", str(e.exception))

    def test_link_into_private_fails(self):
        d = self.mk({"README.md": "see [plan](private/plan.md)\n", "private/plan.md": "x\n"})
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertIn("link", str(e.exception))

    def _linked_repo(self, target):
        d = self.mk({"a.md": "x\n", "private/secret.md": "mine\n"})
        os.symlink(target, os.path.join(d, "innocent.md"))
        git(d, "add", "-A")
        git(d, "commit", "-q", "-m", "link")
        return d

    def test_relative_symlink_refused(self):
        d = self._linked_repo("private/secret.md")
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertIn("symbolic link", str(e.exception))
        self.assertNotIn("secret", str(e.exception))

    def test_absolute_symlink_refused(self):
        d = self._linked_repo("/etc/hosts")
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertIn("symbolic link", str(e.exception))
        self.assertNotIn("innocent", str(e.exception))

    def test_untracked_files_cannot_slip_in(self):
        d = self.mk({"a.md": "x\n"})
        with open(os.path.join(d, "stray-notes.md"), "w") as f:
            f.write("my %s\n" % IP("10", "9", "8", "7"))
        os.makedirs(os.path.join(d, "__pycache__"))
        with open(os.path.join(d, "__pycache__", "x.pyc"), "wb") as f:
            f.write(b"\xff\x00")
        self.assertEqual(build.build("HEAD", self.out(), self.pat, repo=d), ["a.md"])

    def test_bom_does_not_hide_the_first_entry(self):
        d = self.mk({"a.md": "has %s in it\n" % self.WORD})
        with open(self.wl.name, "w", encoding="utf-8-sig") as f:
            f.write(self.WORD + "\n")
        with self.assertRaises(build.PublishError):
            build.build("HEAD", self.out(), build.load_wordlist(self.wl.name), repo=d)
        pat = build.load_wordlist(None, "\ufeff" + self.WORD + "\n")
        with self.assertRaises(build.PublishError):
            build.build("HEAD", self.out(), pat, repo=d)

    def test_exclude_file_missing_or_stale_fails(self):
        d = make_repo({"a.md": "x\n", "private/plan.md": "mine\n"})
        with self.assertRaises(build.PublishError):
            build.build("HEAD", self.out(), self.pat, repo=d)
        d2 = self.mk({"a.md": "x\n", "private/public-exclude.txt": "gone/file.yml\n"})
        with self.assertRaises(build.PublishError):
            build.build("HEAD", self.out(), self.pat, repo=d2)

    def without_data_filter(self):
        """Make tarfile look like Apple's Python 3.9.6, which has no data_filter."""
        saved = getattr(tarfile, "data_filter", None)
        if saved is not None:
            del tarfile.data_filter
            self.addCleanup(setattr, tarfile, "data_filter", saved)

    def test_old_python_path_validates_members(self):
        self.without_data_filter()

        def tar(name, kind=tarfile.REGTYPE, link=""):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w") as t:
                ti = tarfile.TarInfo(name)
                ti.type = kind
                ti.linkname = link
                data = b"x"
                ti.size = len(data) if kind == tarfile.REGTYPE else 0
                t.addfile(ti, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
            return buf.getvalue()
        out = self.out()
        build.extract(tar("ok/a.md"), out)
        self.assertTrue(os.path.isfile(os.path.join(out, "ok", "a.md")))
        with open(os.path.join(out, "ok", "a.md"), "rb") as f:
            self.assertEqual(f.read(), b"x")                 # content arrives intact
        for bad in (tar("../evil"), tar("/abs/evil"), tar("l", tarfile.SYMTYPE, "/etc/hosts"),
                    tar("f", tarfile.FIFOTYPE)):
            out = self.out()
            with self.assertRaises(build.PublishError):
                build.extract(bad, out)
            self.assertEqual(os.listdir(out) if os.path.isdir(out) else [], [])
        d = self._linked_repo("private/secret.md")
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        self.assertIn("symbolic link", str(e.exception))

    def test_executable_bit_survives_both_extraction_paths(self):
        d = self.mk({"a.md": "x\n", "hooks/run.sh": "#!/bin/sh\n"})
        os.chmod(os.path.join(d, "hooks", "run.sh"), 0o755)
        git(d, "add", "-A")
        git(d, "commit", "-q", "-m", "exec")

        def modes(out):
            return {rel: stat.S_IMODE(os.stat(os.path.join(out, rel)).st_mode)
                    for rel in ("a.md", "hooks/run.sh")}
        want = {"a.md": 0o644, "hooks/run.sh": 0o755}
        out = self.out()
        build.build("HEAD", out, self.pat, repo=d)              # this Python's own path
        self.assertEqual(modes(out), want)
        self.without_data_filter()
        out = self.out()
        build.build("HEAD", out, self.pat, repo=d)              # the path Apple's 3.9.6 takes
        self.assertEqual(modes(out), want)

    def test_committed_bytecode_is_checked(self):
        d = self.mk({"a.md": "x\n"})
        os.makedirs(os.path.join(d, "__pycache__"))
        with open(os.path.join(d, "__pycache__", "m.cpython-39.pyc"), "wb") as f:
            f.write(b"\xff\xfe\x00" + self.WORD.encode())
        git(d, "add", "-f", "__pycache__/m.cpython-39.pyc")
        git(d, "commit", "-q", "-m", "bytecode")
        with self.assertRaises(build.PublishError) as e:
            build.build("HEAD", self.out(), self.pat, repo=d)
        msg = str(e.exception)
        self.assertIn("file #1 (in sorted order): not UTF-8 text", msg)   # the build's own report
        self.assertIn("__pycache__/m.cpython-39.pyc: not UTF-8 text", msg)  # check_repo, strict
        self.assertNotIn(self.WORD, msg)

    def test_flagged_name_is_hidden_from_every_other_finding(self):
        email_name = "notes-a" + "@mail-provider.com.md"
        ip = IP("10", "1", "2", "3")
        cases = [
            {email_name: "has %s\n" % self.WORD},                       # + a word in the content
            {"host-%s.md" % ip: "see [p](private/plan.md)\n"},           # + a link into private/
            {"host-%s.md" % ip: "%s\n" % IP("10", "9", "9", "9")},       # + an IP in the content
            {"x-%s.md" % self.WORD: "mail b" + "@mail-provider.com\n"},  # word-list name + email
        ]
        for files in cases:
            with self.subTest(files=sorted(files)[0][:6]):
                files = dict(files, **{"private/plan.md": "x\n"})
                with self.assertRaises(build.PublishError) as e:
                    build.build("HEAD", self.out(), self.pat, repo=self.mk(files))
                msg = str(e.exception)
                self.assertIn("file #1 (in sorted order)", msg)
                for value in ("mail-provider", ip, self.WORD, "host-", "notes-"):
                    self.assertNotIn(value, msg.lower())

    def test_link_forms_into_private_fail(self):
        good = ("[a](ok.md \"title\") [b](<ok.md>) <ok.md> <WORKER_URL> <br/> </details>\n"
                "[ref]: ok.md\n<a href=\"ok.md\">x</a> <img src='ok.md'>\n"
                "<source srcset=\"ok.md 1x, ok.md 2x\"> [w](https://example.com/private/x)\n"
                "[^1]: a footnote, not a link\n")
        self.assertEqual(build.build("HEAD", self.out(), self.pat,
                                     repo=self.mk({"README.md": good, "ok.md": "x\n"})),
                         ["README.md", "ok.md"])
        for form in ("[p]: private/plan.md", "   [p]: <private/plan.md> \"t\"", "> [p]: private/plan.md",
                     "[p](private/plan.md \"title\")", "[p](<private/plan.md>)", "<private/plan.md>",
                     "</private/plan.md>", "<a href=\"private/plan.md\">p</a>",
                     "<a HREF=private/plan.md>p</a>", "<img src='private/plan.md'>",
                     "<img srcset=\"ok.md 1x, private/plan.md 2x\">", "[p](private%2Fplan.md)",
                     "[p](private/plan.md?raw=1)"):
            with self.subTest(form=form):
                d = self.mk({"README.md": "%s\n" % form, "ok.md": "x\n", "private/plan.md": "x\n"})
                with self.assertRaises(build.PublishError) as e:
                    build.build("HEAD", self.out(), self.pat, repo=d)
                self.assertIn("README.md:1: link", str(e.exception))
        d = self.mk({"docs/a.md": "[p](../private/plan.md)\n", "private/plan.md": "x\n"})
        with self.assertRaises(build.PublishError):
            build.build("HEAD", self.out(), self.pat, repo=d)

    def test_explain_reads_a_bom_and_hides_names(self):
        email_name = "notes-a" + "@mail-provider.com.md"
        d = make_repo({"a.md": "has %s\n" % self.WORD, email_name: "%s\n" % self.WORD})
        with open(self.wl.name, "w", encoding="utf-8-sig") as f:
            f.write(self.WORD + "\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = build.explain(d, self.wl.name)
        out = buf.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("word-list line 1 matches a.md:1", out)
        self.assertIn("word-list line 1 matches file #2 (in sorted order):1", out)
        self.assertNotIn(self.WORD, out)
        self.assertNotIn("mail-provider", out)

    def test_failed_build_leaves_no_output(self):
        d = self.mk({"a.md": "has %s\n" % self.WORD})
        out = self.out()
        with self.assertRaises(build.PublishError):
            build.build("HEAD", out, self.pat, repo=d)
        self.assertFalse(os.path.exists(out))
        busy = tempfile.mkdtemp()
        open(os.path.join(busy, "keep"), "w").close()
        with self.assertRaises(build.PublishError):
            build.build("HEAD", busy, self.pat, repo=d)
        self.assertTrue(os.path.exists(os.path.join(busy, "keep")))   # not ours: untouched

    def test_empty_archive_message(self):
        with self.assertRaises(build.PublishError) as e:
            build.extract(b"", self.out())
        self.assertIn("empty or unreadable", str(e.exception))

    def test_cli_hides_errors_and_names(self):
        d = self.mk({"a.md": "x\n"})
        bad = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
        bad.write("(unclosed-%s\n" % self.WORD)
        bad.close()
        self.addCleanup(os.unlink, bad.name)
        r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts", "release", "build_public.py"),
                            "HEAD", self.out(), "--wordlist", bad.name], capture_output=True, text=True, cwd=d)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn(self.WORD, r.stderr + r.stdout)
        self.assertNotIn("Traceback", r.stderr)
        r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts", "release", "build_public.py"),
                            "HEAD", self.out(), "--wordlist", d], capture_output=True, text=True, cwd=d)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Traceback", r.stderr)


class PublishPublic(unittest.TestCase):
    """The public commit preparer, against local bare repos. No network."""

    BOT = "claude-code-discord-bridge release <41898282+github-actions[bot]@users.noreply.github.com>"
    OWNER = "hi@rpaprocki.com"

    def setUp(self):
        # A public repo that already has one commit (for example GitHub's README): the first
        # release must name it with --first-base. The empty repo has its own tests below.
        seed = make_repo({".github/FUNDING.yml": "github: someone\n"})
        self.seed = git(seed, "rev-parse", "HEAD")
        self.remote = tempfile.mkdtemp()
        git(self.remote, "init", "-q", "--bare", "-b", "main")
        git(seed, "push", "-q", self.remote, "main")
        self.public = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", self.remote, self.public], check=True, env=ENV,
                       capture_output=True)
        self.copy = tempfile.mkdtemp()
        self._write("README.md", "v1\n")
        self._write("old.txt", "goes away later\n")

    def empty_public(self):
        """A bare repo with no commits (GitHub's "create" with nothing ticked) and a clone of it."""
        remote = tempfile.mkdtemp()
        git(remote, "init", "-q", "--bare", "-b", "main")
        public = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", remote, public], check=True, env=ENV, capture_output=True)
        return remote, public

    def with_env(self, **values):
        old = os.environ.copy()
        os.environ.update(values)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(old)))

    def _write(self, path, text):
        full = os.path.join(self.copy, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def _commit_by_hand(self, name, text):
        with open(os.path.join(self.public, name), "w") as f:
            f.write(text)
        git(self.public, "add", "-A")
        git(self.public, "commit", "-q", "-m", "by hand")

    def test_first_release_then_second_deletes_removed_files(self):
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed), "prepared")
        self.assertEqual(git(self.public, "log", "-1", "--format=%s"), "claude-code-discord-bridge 0.1.0")
        self.assertEqual(git(self.public, "rev-list", "--count", "HEAD"), "2")   # on top of initial
        self.assertFalse(os.path.exists(os.path.join(self.public, ".github")))
        os.unlink(os.path.join(self.copy, "old.txt"))
        self.assertEqual(publish.prepare(self.public, self.copy, "0.2.0"), "prepared")
        self.assertFalse(os.path.exists(os.path.join(self.public, "old.txt")))
        self.assertEqual(git(self.public, "tag", "--list"), "v0.1.0\nv0.2.0")

    def test_direct_commit_on_public_repo_stops_it(self):
        publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        self._commit_by_hand("hotfix.txt", "someone committed here\n")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.2.0")

    def test_first_release_refused_if_public_already_has_extra_commits(self):
        self._commit_by_hand("x.txt", "x\n")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.1.0")
        with self.assertRaises(publish.PublishError):                     # not the acknowledged one
            publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)

    def test_any_existing_commit_needs_first_base(self):
        # A single initial commit (GitHub's README, licence or .gitignore) is not published on
        # top of silently: the public history would start with a commit that isn't the bot's.
        with self.assertRaisesRegex(publish.PublishError, "--first-base"):
            publish.prepare(self.public, self.copy, "0.1.0")
        self.assertEqual(git(self.public, "rev-parse", "HEAD"), self.seed)
        self.assertEqual(git(self.public, "tag", "--list"), "")
        self.assertTrue(os.path.exists(os.path.join(self.public, ".github", "FUNDING.yml")))

    def test_first_release_into_an_empty_public_repo(self):
        remote, public = self.empty_public()
        with self.assertRaises(publish.PublishError):                     # nothing to acknowledge
            publish.prepare(public, self.copy, "0.1.0", first_base=self.seed)
        self.assertEqual(publish.prepare(public, self.copy, "0.1.0"), "prepared")
        self.assertEqual(git(public, "rev-list", "--count", "HEAD"), "1")    # the bot's commit only
        self.assertEqual(publish.push(public, "0.1.0"), "pushed")
        self.assertEqual(publish.push(public, "0.1.0"), "unchanged")         # a second run: no-op
        self.assertEqual(publish.prepare(public, self.copy, "0.1.0"), "exists")
        self.assertEqual(git(remote, "rev-list", "--count", "main"), "1")
        self.assertEqual(git(remote, "tag", "--list"), "v0.1.0")
        self.assertEqual(git(remote, "log", "-1", "--format=%an <%ae>", "main"), self.BOT)
        self._write("README.md", "v2\n")
        self.assertEqual(publish.prepare(public, self.copy, "0.2.0"), "prepared")
        self.assertEqual(git(public, "rev-list", "--count", "HEAD"), "2")

    def test_unborn_head_with_refs_is_refused(self):
        seed = make_repo({"x.txt": "x\n"})
        remote, _ = self.empty_public()
        git(seed, "push", "-q", remote, "main:other")          # a branch, but no main
        public = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", remote, public], check=True, env=ENV, capture_output=True)
        with self.assertRaises(publish.PublishError):
            publish.prepare(public, self.copy, "0.1.0")
        self.assertEqual(git(public, "tag", "--list"), "")

    def test_global_excludes_and_the_copys_gitignore_drop_nothing(self):
        self._write("worker/.dev.vars.example", "DISCORD_BOT_TOKEN=\n")
        self._write(".gitignore", "notes.local\n")
        self._write("notes.local", "force-added in the private repo, so it is in the copy\n")
        hostile = tempfile.mkdtemp()
        excludes = os.path.join(hostile, "ignore")
        with open(excludes, "w") as f:
            f.write("*.example\n*.md\n")
        gcfg = os.path.join(hostile, "gitconfig")
        with open(gcfg, "w") as f:
            f.write("[core]\n\texcludesFile = %s\n" % excludes)
        os.makedirs(os.path.join(self.public, ".git", "info"), exist_ok=True)
        with open(os.path.join(self.public, ".git", "info", "exclude"), "a") as f:
            f.write("*.txt\n")
        self.with_env(GIT_CONFIG_GLOBAL=gcfg)
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed), "prepared")
        self.assertEqual(git(self.public, "ls-tree", "-r", "--name-only", "HEAD").splitlines(),
                         [".gitignore", "README.md", "notes.local", "old.txt", "worker/.dev.vars.example"])

    def test_staged_tree_must_equal_the_copy(self):
        word = "zz-secret-word-zz"
        self._write("sub/.git/%s.txt" % word, "git never stages a .git directory\n")
        with self.assertRaises(publish.PublishError) as e:
            publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        msg = str(e.exception)
        self.assertIn("1 file", msg)
        for name in (word, "sub", ".git/"):
            self.assertNotIn(name, msg)
        self.assertEqual(git(self.public, "rev-parse", "HEAD"), self.seed)       # nothing committed
        self.assertEqual(git(self.public, "tag", "--list"), "")
        shutil.rmtree(os.path.join(self.copy, "sub"))
        self._write("run.sh", "#!/bin/sh\n")
        os.chmod(os.path.join(self.copy, "run.sh"), 0o755)
        git(self.public, "config", "core.fileMode", "false")              # would record 100644
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        self.assertEqual(git(self.public, "tag", "--list"), "")
        git(self.public, "config", "core.fileMode", "true")
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed), "prepared")
        self.assertEqual(git(self.public, "ls-files", "-s", "run.sh").split()[0], "100755")

    def test_relative_paths_work(self):
        # git -C reads paths from the clone, not from where the script was started.
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(tempfile.gettempdir())
        public, copy = os.path.relpath(self.public), os.path.relpath(self.copy)
        self.assertEqual(publish.prepare(public, copy, "0.1.0", first_base=self.seed), "prepared")
        self.assertEqual(git(self.public, "ls-tree", "-r", "--name-only", "HEAD").splitlines(),
                         ["README.md", "old.txt"])

    def test_commit_and_tag_times_are_utc(self):
        self.with_env(TZ="XYZ-5:30")                             # a Mac set to some other zone
        publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        for when in git(self.public, "log", "-1", "--format=%ai%n%ci").splitlines():
            self.assertTrue(when.endswith(" +0000"), when)
        tagger = [l for l in git(self.public, "cat-file", "-p", "v0.1.0").splitlines()
                  if l.startswith("tagger ")]
        self.assertTrue(tagger[0].endswith(" +0000"), tagger)

    def test_first_release_on_acknowledged_base(self):
        self._commit_by_hand("x.txt", "owner edit\n")
        head = git(self.public, "rev-parse", "HEAD")
        with self.assertRaises(publish.PublishError):                     # wrong base
            publish.prepare(self.public, self.copy, "0.1.0", first_base="0000000")
        with self.assertRaises(publish.PublishError):                     # too short
            publish.prepare(self.public, self.copy, "0.1.0", first_base=head[:3])
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0", first_base=head[:7]), "prepared")

    def test_rerun_after_half_done_publish_is_a_no_op(self):
        publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)          # commit + tag made, push "failed"
        self.assertEqual(git(self.remote, "tag", "--list"), "")
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0"), "exists")
        self.assertEqual(publish.push(self.public, "0.1.0"), "pushed")     # finishes the public side once
        self.assertEqual(git(self.remote, "tag", "--list"), "v0.1.0")
        self.assertEqual(git(self.remote, "rev-parse", "main"), git(self.public, "rev-parse", "HEAD"))
        self.assertEqual(git(self.remote, "rev-list", "--count", "main"), "2")
        # a second run, and a fresh clone's run, change nothing
        self.assertEqual(publish.prepare(self.public, self.copy, "0.1.0"), "exists")
        self.assertEqual(publish.push(self.public, "0.1.0"), "unchanged")
        fresh = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", self.remote, fresh], check=True, env=ENV, capture_output=True)
        self.assertEqual(publish.prepare(fresh, self.copy, "0.1.0"), "exists")
        self.assertEqual(publish.push(fresh, "0.1.0"), "unchanged")
        self.assertEqual(git(self.remote, "rev-list", "--count", "main"), "2")
        self.assertEqual(git(self.remote, "tag", "--list"), "v0.1.0")
        # same tag, other content: stop
        self._write("README.md", "different\n")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.1.0")

    def test_older_version_refused(self):
        publish.prepare(self.public, self.copy, "1.1.0", first_base=self.seed)
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "1.0.5")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "1.1")

    def test_public_commit_is_by_the_bot(self):
        hooks = tempfile.mkdtemp()
        hook = os.path.join(hooks, "commit-msg")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\necho 'Signed-off-by: Owner <%s>' >> \"$1\"\n" % self.OWNER)
        os.chmod(hook, 0o755)
        tmpl = os.path.join(hooks, "template.txt")
        with open(tmpl, "w") as f:
            f.write("template by %s\n" % self.OWNER)
        gcfg = os.path.join(hooks, "gitconfig")
        with open(gcfg, "w") as f:
            f.write("[user]\n\tname = Owner\n\temail = %s\n[core]\n\thooksPath = %s\n"
                    "[commit]\n\ttemplate = %s\n" % (self.OWNER, hooks, tmpl))
        old = os.environ.copy()
        os.environ.update(GIT_CONFIG_GLOBAL=gcfg, GIT_AUTHOR_NAME="Owner", GIT_AUTHOR_EMAIL=self.OWNER,
                          GIT_COMMITTER_NAME="Owner", GIT_COMMITTER_EMAIL=self.OWNER)
        try:
            publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        finally:
            os.environ.clear()
            os.environ.update(old)
        self.assertEqual(publish.BOT, self.BOT)
        self.assertEqual(publish.NAME, "claude-code-discord-bridge")
        self.assertEqual(git(self.public, "log", "-1", "--format=%an <%ae>"), self.BOT)
        self.assertEqual(git(self.public, "log", "-1", "--format=%cn <%ce>"), self.BOT)
        log = git(self.public, "log", "--all", "--format=%ae%n%ce%n%B")
        tag_body = git(self.public, "cat-file", "-p", "v0.1.0")
        self.assertNotIn(self.OWNER, log)
        self.assertNotIn(self.OWNER, tag_body)
        self.assertNotIn("Signed-off-by", log + tag_body)
        self.assertIn(self.BOT, tag_body)

    def test_older_version_refused_even_if_tag_exists(self):
        publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        publish.prepare(self.public, self.copy, "0.2.0")
        with self.assertRaisesRegex(publish.PublishError, "older"):
            publish.prepare(self.public, self.copy, "0.1.0")

    def test_already_tagged_on_moved_repo_is_refused(self):
        publish.prepare(self.public, self.copy, "0.1.0", first_base=self.seed)
        self._commit_by_hand("hotfix.txt", "x\n")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.1.0")

    def test_copy_with_git_entry_is_refused_before_touching_clone(self):
        self._write(".git/config", "x\n")
        with self.assertRaises(publish.PublishError):
            publish.prepare(self.public, self.copy, "0.1.0")
        self.assertTrue(os.path.exists(os.path.join(self.public, ".github", "FUNDING.yml")))
        self.assertEqual(git(self.public, "tag", "--list"), "")


class ReleaseRehearsal(unittest.TestCase):
    """The first publish end to end, as on the owner's Mac: build the public copy of a small
    private repo, prepare and push it into an EMPTY public repo, then run it all again (a no-op).
    Local bare repos only. The owner's git config is hostile on purpose."""

    OWNER = "hi@rpaprocki.com"
    BOT = PublishPublic.BOT

    def run_script(self, name, *args, **kw):
        return subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts", "release", name)]
                              + list(args), capture_output=True, text=True, **kw)

    def hostile_env(self):
        d = tempfile.mkdtemp()
        hook = os.path.join(d, "commit-msg")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\necho 'Signed-off-by: Owner <%s>' >> \"$1\"\n" % self.OWNER)
        os.chmod(hook, 0o755)
        with open(os.path.join(d, "ignore"), "w") as f:
            f.write("*.example\n")
        with open(os.path.join(d, "gitconfig"), "w") as f:
            f.write("[user]\n\tname = Owner\n\temail = %s\n[core]\n\thooksPath = %s\n\texcludesFile = %s\n"
                    % (self.OWNER, d, os.path.join(d, "ignore")))
        return dict(os.environ, GIT_CONFIG_GLOBAL=os.path.join(d, "gitconfig"), TZ="XYZ-5:30")

    def test_first_publish_end_to_end(self):
        private = make_repo({
            "README.md": "# demo\nSee [the licence](LICENSE).\n",
            "LICENSE": "GPL\n",
            "hooks/hook.sh": "#!/bin/sh\necho hi\n",
            "worker/.dev.vars.example": "DISCORD_BOT_TOKEN=\n",
            ".github/workflows/cut-release.yml": "private workflow\n",
            "private/public-exclude.txt": "# never public\n.github/workflows/cut-release.yml\n",
            "private/RELEASING.md": "owner notes\n",
        })
        os.chmod(os.path.join(private, "hooks", "hook.sh"), 0o755)
        add_commit(private, {".gitignore": "*.example\n"}, "Release 0.1.0 [no changelog]")
        git(private, "tag", "-a", "v0.1.0", "-m", "claude-code-discord-bridge 0.1.0")
        wordlist = os.path.join(tempfile.mkdtemp(), "wordlist")
        with open(wordlist, "w") as f:
            f.write("zz-rehearsal-word-zz\n")
        env = self.hostile_env()

        copy = os.path.join(tempfile.mkdtemp(), "copy")
        r = self.run_script("build_public.py", "v0.1.0", copy, "--wordlist", wordlist,
                            "--message", "claude-code-discord-bridge 0.1.0", cwd=private, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        remote = tempfile.mkdtemp()
        git(remote, "init", "-q", "--bare", "-b", "main")
        public = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", remote, public], check=True, env=ENV, capture_output=True)
        git(public, "fetch", "-q", "--tags", "origin")         # RELEASING fetches right before prepare
        r = self.run_script("publish_public.py", "prepare", public, copy, "0.1.0", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)

        # The dry run before any real push: it sends nothing, and a remote that refuses writes
        # (like a read-only deploy key) fails it.
        dry = ["git", "-C", public, "push", "--dry-run", "--atomic", "origin", "HEAD:refs/heads/main",
               "refs/tags/v0.1.0"]
        self.assertEqual(subprocess.run(dry, env=ENV, capture_output=True).returncode, 0)
        self.assertEqual(git(remote, "for-each-ref"), "")
        refuse = os.path.join(tempfile.mkdtemp(), "refuse")
        with open(refuse, "w") as f:
            f.write("#!/bin/sh\necho 'ERROR: this key is read only' >&2\nexit 1\n")
        os.chmod(refuse, 0o755)
        readonly = dry[:3] + ["-c", "remote.origin.receivepack=" + refuse] + dry[3:]
        self.assertNotEqual(subprocess.run(readonly, env=ENV, capture_output=True).returncode, 0)
        self.assertEqual(git(remote, "for-each-ref"), "")

        r = self.run_script("publish_public.py", "push", public, "0.1.0", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("pushed", r.stdout)

        # One commit by the bot, in UTC, tagged, holding exactly the copy with its modes.
        self.assertEqual(git(remote, "rev-list", "--count", "main"), "1")
        self.assertEqual(git(remote, "rev-parse", "v0.1.0^{commit}"), git(remote, "rev-parse", "main"))
        self.assertEqual(git(remote, "log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", "main"),
                         "%s\n%s\nclaude-code-discord-bridge 0.1.0" % (self.BOT, self.BOT))
        self.assertTrue(git(remote, "log", "-1", "--format=%ai", "main").endswith(" +0000"))
        tree = {line.split("\t")[1]: line.split()[0]
                for line in git(remote, "ls-tree", "-r", "main").splitlines()}
        self.assertEqual(tree, {".gitignore": "100644", "LICENSE": "100644", "README.md": "100644",
                                "hooks/hook.sh": "100755", "worker/.dev.vars.example": "100644"})
        everything = git(remote, "log", "--all", "--format=%ae%n%ce%n%B") + git(remote, "cat-file", "-p", "v0.1.0")
        self.assertNotIn(self.OWNER, everything)
        self.assertNotIn("Signed-off-by", everything)

        # Run it all again: nothing changes.
        r = self.run_script("publish_public.py", "push", public, "0.1.0", env=env)
        self.assertEqual((r.returncode, "already pushed" in r.stdout), (0, True), r.stdout + r.stderr)
        r = self.run_script("publish_public.py", "prepare", public, copy, "0.1.0", env=env)
        self.assertEqual((r.returncode, "already in the public clone" in r.stdout), (0, True), r.stderr)
        fresh = tempfile.mkdtemp()
        subprocess.run(["git", "clone", "-q", remote, fresh], check=True, env=ENV, capture_output=True)
        r = self.run_script("publish_public.py", "prepare", fresh, copy, "0.1.0", env=env)
        self.assertEqual((r.returncode, "already in the public clone" in r.stdout), (0, True), r.stderr)
        r = self.run_script("publish_public.py", "push", fresh, "0.1.0", env=env)
        self.assertEqual((r.returncode, "already pushed" in r.stdout), (0, True), r.stderr)
        self.assertEqual(git(remote, "rev-list", "--count", "main"), "1")
        self.assertEqual(git(remote, "tag", "--list"), "v0.1.0")


class ChangelogTests(unittest.TestCase):
    def test_bumps(self):
        self.assertEqual(changelog.plan(CL)["version"], "1.2.4")
        self.assertEqual(changelog.plan(CL.replace("### Fixed", "### Added", 1))["version"], "1.3.0")
        self.assertEqual(changelog.plan(CL.replace("- a bug", "- **Breaking** x", 1))["version"], "2.0.0")
        self.assertEqual(changelog.plan(CL.replace("### Fixed", "### Removed", 1))["version"], "2.0.0")
        self.assertEqual(changelog.plan(CL, bump="minor")["version"], "1.3.0")

    def test_first_release(self):
        first = CL.split("## [1.2.3]")[0]
        self.assertEqual(changelog.plan(first)["version"], "0.1.0")

    def test_upgrading_line_required(self):
        with self.assertRaises(changelog.ChangelogError):
            changelog.plan(CL.replace("**Upgrading:** nothing to do.\n\n### Fixed", "### Fixed", 1))

    def test_set_version(self):
        src = '// header\nexport const VERSION = "0.0.0";\n'
        self.assertEqual(changelog.set_version(src, "1.2.3"),
                         '// header\nexport const VERSION = "1.2.3";\n')
        with self.assertRaises(changelog.ChangelogError):
            changelog.set_version(src, "1.2")
        with self.assertRaises(changelog.ChangelogError):
            changelog.set_version("x = 1\n", "1.2.3")
        self.assertEqual(changelog.VERSION_FILE, "worker/src/version.ts")

    def test_code_version_matches_newest_release(self):
        with open(os.path.join(ROOT, "CHANGELOG.md")) as f:
            newest = changelog.previous_version(f.read()) or "0.0.0"
        with open(os.path.join(ROOT, changelog.VERSION_FILE)) as f:
            src = f.read()
        self.assertEqual(src, 'export const VERSION = "%s";\n' % newest,
                         "worker/src/version.ts and CHANGELOG.md disagree")

    def test_finalize(self):
        new = changelog.finalize(CL, "1.2.4", "2026-02-02")
        self.assertIn("## [Unreleased]\n\n## [1.2.4] - 2026-02-02", new)
        self.assertEqual(changelog.notes(new, "1.2.4").splitlines()[0], "**Upgrading:** nothing to do.")
        with self.assertRaises(changelog.ChangelogError):
            changelog.finalize(new, "1.2.3", "2026-02-02")

    def test_finalize_keeps_a_blank_line_before_upgrading(self):
        new = changelog.finalize(CL, "1.2.4", "2026-02-02")
        self.assertIn("## [1.2.4] - 2026-02-02\n\n**Upgrading:** nothing to do.\n", new)
        trailing = changelog.finalize(CL.replace("## [Unreleased]\n", "## [Unreleased]  \n"),
                                      "1.2.4", "2026-02-02")
        self.assertIn("## [1.2.4] - 2026-02-02\n\n**Upgrading:**", trailing)


class ChangelogCheckTests(unittest.TestCase):
    def setUp(self):
        self.repo = make_repo({"CHANGELOG.md": "# Changelog\n", "worker/src/a.ts": "x\n"})
        self.base = git(self.repo, "rev-parse", "HEAD")

    def flagged(self):
        return changelog_check.flagged(self.base, repo=self.repo)

    def test_changelog_check_flags_a_visible_path_without_a_line(self):
        for path in ("worker/src/deep/b.ts", "worker/wrangler.toml", "worker/.dev.vars.example",
                     "worker/package.json", "hooks/bridge-hook.sh", "examples/x.json", "README.md"):
            add_commit(self.repo, {path: "change\n"}, "change " + path)
        self.assertEqual(len(self.flagged()), 7)
        add_commit(self.repo, {"tests/t.py": "x\n", "worker/test/t.ts": "x\n", "docs/d.md": "x\n"},
                   "invisible")
        self.assertEqual(len(self.flagged()), 7)

    def test_visible_path_with_a_changelog_line_passes(self):
        add_commit(self.repo, {"worker/src/c.ts": "x\n", "CHANGELOG.md": "# Changelog\nmore\n"}, "feat")
        self.assertEqual(self.flagged(), [])

    def test_no_changelog_marker_opts_out(self):
        add_commit(self.repo, {"worker/src/b.ts": "x\n"}, "fix typo [no changelog]")
        self.assertEqual(self.flagged(), [])
        add_commit(self.repo, {"worker/src/b.ts": "y\n"}, "fix a thing")
        self.assertEqual(len(self.flagged()), 1)

    def test_commits_before_the_check_existed_are_never_checked(self):
        add_commit(self.repo, {"README.md": "old\n"}, "an old visible change")
        add_commit(self.repo, {"scripts/release/changelog_check.py": "x\n"}, "add the check [no changelog]")
        self.assertEqual(self.flagged(), [])
        self.assertEqual(changelog_check.flagged(None, repo=self.repo), [])
        add_commit(self.repo, {"README.md": "new\n"}, "a new visible change")
        self.assertEqual([s for _, s, _ in self.flagged()], ["a new visible change"])
        git(self.repo, "tag", "v0.1.0")                       # a later base still wins
        add_commit(self.repo, {"hooks/h.sh": "x\n"}, "after the tag")
        self.assertEqual([s for _, s, _ in changelog_check.flagged("v0.1.0", repo=self.repo)],
                         ["after the tag"])


BUTTON = ("[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)]"
          "(https://deploy.workers.cloudflare.com/?url="
          "https://github.com/rob-paprocki/claude-code-discord-bridge/tree/main/worker)")


def read(*parts):
    with open(os.path.join(ROOT, *parts)) as f:
        return f.read()


def workflow_jobs(text):
    """{job name: its text} of a workflow file, split on the two-space keys under "jobs:"."""
    jobs, name = {}, None
    for line in text.split("\njobs:\n", 1)[1].splitlines():
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            name = m.group(1)
            jobs[name] = ""
        elif name:
            jobs[name] += line + "\n"
    return jobs


def workflow_steps(job):
    """The steps of a job's text, each starting at its "      - " line."""
    return ["      - " + s for s in job.split("\n      - ")[1:]]


HAS_PRIVATE = os.path.isdir(os.path.join(ROOT, "private"))


class PublicShape(unittest.TestCase):
    """What the public repository and the Deploy to Cloudflare button need."""

    def test_worker_folder_is_self_contained(self):
        import json
        for name in ("package.json", "package-lock.json", "wrangler.toml", ".dev.vars.example"):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, "worker", name)), name)
        keys = [l.split("=")[0].strip() for l in read("worker", ".dev.vars.example").splitlines()
                if l.strip() and not l.lstrip().startswith("#")]
        self.assertEqual(keys, ["DISCORD_BOT_TOKEN"])
        values = [l.split("=", 1)[1] for l in read("worker", ".dev.vars.example").splitlines()
                  if l.strip() and not l.lstrip().startswith("#")]
        self.assertEqual(values, [""])                  # the example never holds a token
        pkg = json.loads(read("worker", "package.json"))
        desc = pkg["cloudflare"]["bindings"]["DISCORD_BOT_TOKEN"]["description"]
        self.assertTrue(desc.strip())
        self.assertEqual(list(pkg["cloudflare"]["bindings"]), ["DISCORD_BOT_TOKEN"])

    def test_worker_folder_carries_the_licence(self):
        # A Deploy to Cloudflare copy holds only worker/, so it needs its own copy of the licence.
        self.assertEqual(read("worker", "LICENSE"), read("LICENSE"))

    def test_wrangler_toml_has_no_routes_or_ids(self):
        import re
        toml = read("worker", "wrangler.toml")
        for word in ("routes", "route", "account_id", "zone"):
            self.assertIsNone(re.search(r"^\s*\[*%s\b|\b%s_" % (word, word), toml, re.M), word)

    @unittest.skipUnless(HAS_PRIVATE, "private/ is not in the public copy")
    def test_cut_release_is_excluded_and_guarded(self):
        lines = [l.strip() for l in read("private", "public-exclude.txt").splitlines()]
        self.assertIn(".github/workflows/cut-release.yml", lines)
        text = read(".github", "workflows", "cut-release.yml")
        self.assertIn("if: github.repository == 'rob-paprocki/claude-code-discord-bridge-private'", text)
        self.assertIn("github.ref == 'refs/heads/main'", text)
        line = "BRIDGE_WORDLIST: ${{ secrets.PUBLIC_WORDLIST }}"
        self.assertEqual(text.count(line), 1)
        self.assertIn(" " * 10 + line, text)          # step level, not job level (6 spaces)
        self.assertNotIn(" " * 6 + line, text.replace(" " * 10 + line, ""))

    def test_release_yml_is_guarded_to_public(self):
        text = read(".github", "workflows", "release.yml")
        self.assertIn("if: github.repository == 'rob-paprocki/claude-code-discord-bridge'", text)
        self.assertNotIn("-private'", text)

    @unittest.skipUnless(HAS_PRIVATE, "private/ is not in the public copy")
    def test_cut_release_tests_run_apart_from_the_secrets(self):
        # npm install scripts and the tests could change the workspace: they run in a job that
        # holds no secrets, and the release job starts only once that job has passed.
        jobs = workflow_jobs(read(".github", "workflows", "cut-release.yml"))
        self.assertEqual(sorted(jobs), ["release", "test"])
        guard = ("if: github.repository == 'rob-paprocki/claude-code-discord-bridge-private'"
                 " && github.ref == 'refs/heads/main'")
        for name, job in jobs.items():
            self.assertIn(guard, job, name)
        self.assertNotIn("secrets.", jobs["test"])
        self.assertIn("contents: read", jobs["test"])
        for command in ("npm ci", "npm test", "npm run typecheck", "bash tests/hooks/run.sh",
                        "unittest discover", "tests/check_repo.py"):
            self.assertIn(command, jobs["test"])
        self.assertIn("needs: test", jobs["release"])
        for word in ("npm", "setup-node", "unittest", "run.sh"):
            self.assertNotIn(word, jobs["release"])

    @unittest.skipUnless(HAS_PRIVATE, "private/ is not in the public copy")
    def test_public_push_is_dry_run_before_anything_is_pushed(self):
        # A read-only deploy key must fail before the private side is pushed, in a rehearsal too.
        steps = workflow_steps(workflow_jobs(read(".github", "workflows", "cut-release.yml"))["release"])
        dry = ('git -C "$RUNNER_TEMP/public" push --dry-run --atomic origin HEAD:refs/heads/main '
               '"refs/tags/v$VERSION"')
        prep = [i for i, s in enumerate(steps) if "publish_public.py prepare" in s]
        self.assertEqual(len(prep), 1)
        step = steps[prep[0]]
        self.assertLess(step.index("publish_public.py prepare"), step.index(dry))
        self.assertNotIn("if:", step)                              # runs when rehearsing too
        later = "".join(steps[prep[0] + 1:])
        self.assertNotIn("push", "".join(steps[:prep[0]]))
        self.assertIn("git push --atomic origin", later)
        rel = read("private", "RELEASING.md")
        dry_by_hand = ("git -C /tmp/bridge-public push --dry-run --atomic origin HEAD:refs/heads/main "
                       "refs/tags/vX.Y.Z")
        self.assertLess(rel.index("publish_public.py prepare /tmp/bridge-public"), rel.index(dry_by_hand))
        self.assertLess(rel.index(dry_by_hand), rel.index("git push --atomic origin HEAD:main vX.Y.Z"))
        self.assertIn("dry-runs the public push", rel)

    @unittest.skipUnless(HAS_PRIVATE, "private/ is not in the public copy")
    def test_releasing_covers_the_first_publish_on_the_mac(self):
        rel = read("private", "RELEASING.md")
        workflow = read(".github", "workflows", "cut-release.yml")
        # Apple's Python runs the suite first (I6); the scripts run the same way everywhere (M4).
        self.assertIn("/usr/bin/python3 -I -m unittest discover -s tests -p 'test_*.py'", rel)
        self.assertNotRegex(rel, r"(?<![/\w])python3 scripts/")
        # The README note goes before 0.1.0 is tagged (M3).
        self.assertIn('"Nothing is released yet"', rel)
        self.assertLess(rel.index('"Nothing is released yet"'),
                        rel.index("scripts/release/changelog.py finalize X.Y.Z"))
        # Workflow steps are named as in the workflow (M4).
        for step in ("4. Private side", "5. Public side"):
            self.assertIn('"%s"' % step, rel)
            self.assertIn("name: %s" % step, workflow)
        # Paths, the word list's format and --explain (M4).
        self.assertIn("`/tmp/bridge-copy` and `/tmp/bridge-public` must not exist beforehand", rel)
        self.assertIn("regular expression", rel)
        self.assertIn("build_public.py --explain", rel)
        # Any commit already in the public repo needs --first-base (C1).
        self.assertIn("--first-base SHA if the public repo already has any commit", rel)

    def test_readme_has_the_deploy_button(self):
        self.assertIn(BUTTON, read("README.md"))

    def test_readme_fits_a_deploy_button_copy(self):
        readme = read("README.md")
        step3 = readme[readme.index("3. **Set the bot token.**"):readme.index("4. **Open `<WORKER_URL>`")]
        self.assertIn("Deploy to Cloudflare", step3)                    # the token is already in
        install = readme[readme.index("## Install the hook client"):readme.index("### Check the setup")]
        self.assertNotIn("your copy", install)                          # a Deploy copy has no hooks/
        self.assertIn("git clone https://github.com/rob-paprocki/claude-code-discord-bridge.git", install)
        self.assertIn("copies the `worker/` folder", readme)


if __name__ == "__main__":
    unittest.main()
