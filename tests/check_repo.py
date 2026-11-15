#!/usr/bin/python3 -I
"""Fail if a published file contains a personal-looking value.

Checks every git-tracked file (or every file under a directory), except
anything in private/, .git/ and node_modules/:

  * email addresses: only placeholders (example.com and its subdomains,
    .invalid), the maintainer's public domain (rpaprocki.com and its subdomains)
    and a few service addresses are allowed;
  * IPv4/IPv6 addresses: only the example network 192.168.100.0/24, loopback,
    0.0.0.0 / 255.255.255.255, the documentation ranges and a few well-known
    public resolvers;
  * MAC addresses: only the documentation range 00:00:5E:00:53:xx.

Everything else fails. This is an allow-list on purpose: it catches real
values without them ever being written down here (this file is public).
Messages name the file, line and KIND of value, never the value itself.

usage: check_repo.py [DIR]      (default: the git checkout this file is in)
"""
import ipaddress
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True      # a run must leave no bytecode behind

EMAIL = re.compile(r"[A-Za-z0-9._%+\[\]-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}")
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.]*\d)")
IPV6 = re.compile(r"(?<![\w:.])([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})(?![\w:])")
MAC = re.compile(r"(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])")

ALLOWED_EMAILS = {"hi@rpaprocki.com", "git@github.com",
                  "41898282+github-actions[bot]@users.noreply.github.com"}
EXAMPLE_NET = ipaddress.ip_network("192.168.100.0/24")
ALLOWED_NETS = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")]
ALLOWED_IPS = {ipaddress.ip_address(a) for a in (
    "0.0.0.0", "255.255.255.255", "1.1.1.1", "8.8.8.8", "::", "::1")}


def email_ok(addr):
    a = addr.lower()
    domain = a.split("@", 1)[1]
    return (a in ALLOWED_EMAILS or domain == "example.com" or domain.endswith(".example.com")
            or domain == "rpaprocki.com" or domain.endswith(".rpaprocki.com")   # the maintainer's public domain
            or domain.endswith(".invalid"))


def ip_ok(ip):
    if ip.version == 4 and ip in EXAMPLE_NET:
        return True
    return ip in ALLOWED_IPS or any(ip in n for n in ALLOWED_NETS if n.version == ip.version)


def scan_text(text):
    """Yield (line_number, kind) for every disallowed value."""
    for n, line in enumerate(text.splitlines(), 1):
        for m in EMAIL.finditer(line):
            if not email_ok(m.group(0)):
                yield n, "email address"
        for m in IPV4.finditer(line):
            try:
                ip = ipaddress.ip_address(m.group(1))
            except ValueError:                       # e.g. leading zeros: not a value we can vouch for
                yield n, "IP address"
                continue
            if not ip_ok(ip):
                yield n, "IP address"
        for m in IPV6.finditer(line):
            try:
                ip = ipaddress.ip_address(m.group(1))
            except ValueError:
                continue
            if not ip_ok(ip):
                yield n, "IPv6 address"
        for m in MAC.finditer(line):
            if not m.group(0).upper().replace("-", ":").startswith("00:00:5E:00:53:"):
                yield n, "MAC address"


def files_in(root, strict=False):
    """The files to check. STRICT (the release build's copy, which is published as it is):
    every file under ROOT, nothing skipped."""
    if strict:
        return [os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
                for d, _dirs, names in os.walk(root) for n in names]
    if os.path.isdir(os.path.join(root, ".git")) or os.path.isfile(os.path.join(root, ".git")):
        out = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True,
                             check=True).stdout.decode()
        return [f for f in out.split("\0") if f]
    found = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
        for name in names:
            # Bytecode the test run itself writes; everything else in __pycache__ is scanned.
            if os.path.basename(d) == "__pycache__" and name.endswith(".pyc"):
                continue
            found.append(os.path.relpath(os.path.join(d, name), root).replace(os.sep, "/"))
    return found


def skipped(rel):
    """private/ at the top, and .git/ or node_modules/ anywhere."""
    parts = rel.replace(os.sep, "/").split("/")
    return parts[0] == "private" or ".git" in parts or "node_modules" in parts


def check(root, counted=None, strict=False):
    """Problems found under ROOT. A finding about a file name never prints the name:
    such files are called "file #N (in sorted order)". If COUNTED is a list, the number
    of files scanned is appended to it. STRICT checks every file (see files_in)."""
    problems = []
    scanned = 0
    for index, rel in enumerate(sorted(files_in(root, strict)), 1):
        if not strict and skipped(rel):
            continue
        path = os.path.join(root, rel)
        if not os.path.lexists(path):                     # tracked, deleted, not yet committed
            continue
        name_kinds = [kind for _line, kind in scan_text(rel)]
        label = "file #%d (in sorted order)" % index if name_kinds else rel
        scanned += 1
        for kind in name_kinds:
            problems.append("%s: %s in the file name" % (label, kind))
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            problems.append("%s: not UTF-8 text" % label)
            continue
        except OSError:
            problems.append("%s: not a readable regular file" % label)
            continue
        for line, kind in scan_text(text):
            problems.append("%s:%d: %s not allowed in public files" % (label, line, kind))
    if counted is not None:
        counted.append(scanned)
    return problems


def main(argv):
    root = argv[1] if len(argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isdir(root):
        print("check_repo: the directory to check does not exist")
        return 1
    counted = []
    problems = check(root, counted)
    if not problems and not counted[0]:
        problems = ["no files were checked"]
    for p in problems:
        print(p)
    print("check_repo: %s" % ("%d problem(s)" % len(problems) if problems else "OK"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
