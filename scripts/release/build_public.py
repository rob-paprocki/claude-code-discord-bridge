#!/usr/bin/python3 -I
"""Build and check the public copy of a release. Fails closed: nothing in OUTDIR
is usable unless this exits 0.

  build_public.py REF OUTDIR (--wordlist FILE | env BRIDGE_WORDLIST) [--message TEXT ...]
      (BRIDGE_WORDLIST holds the list's lines, instead of a file)

Steps:
  1. git archive REF -> OUTDIR   (only committed files: untracked and ignored
     files, bytecode included, cannot slip in)
  2. remove private/ and every path listed in private/public-exclude.txt
  3. refuse symbolic links
  4. the PATH of every file against the private word list (regular expressions,
     one per line) and the check_repo patterns (emails, IPs, MACs). A hit is
     reported only as "file #N (in sorted order)", never by name or word, and
     the build stops there: any other check could print that name
  5. every file must be UTF-8 text (reported by position), and the pattern
     checks (tests/check_repo.py in strict mode: nothing is skipped)
  6. the word list against the CONTENT of every file and against the
     commit/tag messages
  7. links in Markdown files (inline, reference, <...>, href, src, srcset)
     must resolve inside the copy, and none may point into private/

A missing or empty word list fails the run. No message prints a word-list
entry or a matched value.
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import unquote

sys.dont_write_bytecode = True      # a run must leave no bytecode behind

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tests"))
import check_repo  # noqa: E402


class PublishError(Exception):
    pass


def load_wordlist(path=None, env_text=None):
    if path:
        if not os.path.exists(path):         # a pipe (process substitution) is fine
            raise PublishError("word list file is missing")
        with open(path, encoding="utf-8-sig") as f:      # a BOM must not hide the first entry
            text = f.read()
    elif env_text is not None:
        text = env_text.lstrip("\ufeff")
    else:
        raise PublishError("no word list given (--wordlist FILE or BRIDGE_WORDLIST)")
    patterns = []
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            patterns.append(re.compile(line, re.I))
        except re.error:
            raise PublishError("word list line %d is not a valid regular expression" % i) from None
    if not patterns:
        raise PublishError("the word list is empty")
    return patterns


def extract(data, out):
    """Unpack the tar bytes DATA into OUT. Only regular files and directories, nothing
    absolute, nothing with a '..' part. Uses tarfile's own "data" filter where this
    Python has it; otherwise every member is checked here first."""
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            members = t.getmembers()
            if not members:
                raise PublishError("the archive is empty")
            if hasattr(tarfile, "data_filter"):
                t.extractall(out, filter="data")      # refuses links/paths pointing outside
                return
            for m in members:
                parts = m.name.replace("\\", "/").split("/")
                if m.issym() or m.islnk():
                    raise PublishError("the release contains a symbolic link or hard link; "
                                       "refused, path withheld")
                if not (m.isreg() or m.isdir()) or m.name.startswith("/") or ".." in parts:
                    raise PublishError("the release contains an unsafe entry (special file or "
                                       "path outside the copy); refused, path withheld")
            root = os.path.abspath(out)
            for m in members:             # no extractall: no modes, owners or links applied
                dest = os.path.join(root, *[x for x in m.name.split("/") if x not in ("", ".")])
                if m.isdir():
                    os.makedirs(dest, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                src = t.extractfile(m)
                with open(dest, "wb") as f:
                    shutil.copyfileobj(src, f)
                os.chmod(dest, 0o755 if m.mode & 0o100 else 0o644)     # git keeps only this bit
    except tarfile.ReadError:
        raise PublishError("the archive is empty or unreadable") from None
    except tarfile.TarError:
        raise PublishError("the release contains a symbolic link or a path pointing outside "
                           "the copy; refused, path withheld") from None


def archive(ref, out, repo="."):
    os.makedirs(out, exist_ok=True)
    # The owner's git config (core.autocrlf, ...) must not change the bytes of the copy.
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
               GIT_CONFIG_NOSYSTEM="1")
    data = subprocess.run(["git", "-C", repo, "archive", "--format=tar", ref],
                          capture_output=True, check=True, env=env).stdout
    extract(data, out)


def remove_private(out):
    excl = os.path.join(out, "private", "public-exclude.txt")
    if not os.path.isfile(excl):
        raise PublishError("private/public-exclude.txt is missing from the release")
    with open(excl, encoding="utf-8") as f:
        paths = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    for p in paths + ["private"]:
        if p.startswith("/") or ".." in p.split("/"):
            raise PublishError("bad path in public-exclude.txt")
        full = os.path.join(out, p)
        if not os.path.lexists(full):
            raise PublishError("a path listed in public-exclude.txt is not in the release")
        if os.path.isdir(full) and not os.path.islink(full):
            shutil.rmtree(full)
        else:
            os.unlink(full)
    return paths


def all_files(out):
    for d, _dirs, names in os.walk(out):
        for n in names:
            yield os.path.relpath(os.path.join(d, n), out)


def name_kinds(rel, patterns):
    """What flags the path REL: the word list, and the check_repo patterns (emails, IPs, MACs)."""
    kinds = ["a word-list entry matches"] if any(p.search(rel) for p in patterns) else []
    return kinds + ["%s in" % kind for _line, kind in check_repo.scan_text(rel)]


def wordlist_check(out, patterns, messages):
    """(problems, name_hit): flagged file names, word-list hits in content and messages, and
    every file no check can read. A flagged or unreadable file is reported by its position in
    sorted order, never by name; nothing prints a word or a value. NAME_HIT is True if any file
    name was flagged, by the word list or by a check_repo pattern."""
    problems = []
    name_hit = False
    for index, rel in enumerate(sorted(all_files(out)), 1):
        position = "file #%d (in sorted order)" % index
        kinds = name_kinds(rel, patterns)
        label = position if kinds else rel
        for kind in kinds:
            name_hit = True
            problems.append("%s: %s the file name" % (position, kind))
        try:
            with open(os.path.join(out, rel), encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            problems.append("%s: not UTF-8 text, so no check can read it" % position)
            continue
        except OSError:
            problems.append("%s: could not be read" % position)
            continue
        if any(p.search(text) for p in patterns):
            problems.append("%s: a word-list entry matches the content" % label)
    for i, msg in enumerate(messages, 1):
        if any(p.search(msg) for p in patterns):
            problems.append("release message %d: a word-list entry matches" % i)
    return problems, name_hit


# The ways a Markdown file links: [x](path "title") and [x](<path>), reference definitions
# [x]: path (not footnotes, [^1]: text), HTML href=, src= and srcset=, and a bare <path>.
INLINE = re.compile(r"\]\(\s*(?:<([^<>\n]*)>|([^)\s<>]+))")
REFDEF = re.compile(r"^[\s>]*\[(?!\^)[^\]\n]+\]:\s*(?:<([^<>\n]*)>|(\S+))")
HTML_LINK = re.compile(r"""\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""", re.I)
SRCSET = re.compile(r"""\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""", re.I)
ANGLE = re.compile(r"<([^<>\s]+)>")
EXTERNAL = re.compile(r"(https?:|mailto:|#)", re.I)


def link_targets(line):
    """(target, must_exist) for every link on LINE. A bare <...> may be an HTML tag or a
    placeholder such as <WORKER_URL>, so it only must not point into private/ or outside."""
    def first(m):
        return next(g for g in m.groups() if g is not None)
    for m in INLINE.finditer(line):
        yield first(m), True
    m = REFDEF.match(line)
    if m:
        yield first(m), True
    for m in HTML_LINK.finditer(line):
        yield first(m), True
    for m in SRCSET.finditer(line):
        for candidate in first(m).split(","):
            if candidate.split():
                yield candidate.split()[0], True
    for m in ANGLE.finditer(line):
        yield m.group(1), False


def bad_link(target, rel, root, must_exist):
    target = target.strip()
    if not target or EXTERNAL.match(target):
        return False
    path = unquote(re.split(r"[?#]", target, maxsplit=1)[0])
    if not path:
        return False
    if must_exist:
        full = os.path.normpath(os.path.join(root, os.path.dirname(rel), path))
    else:                                     # "/x" read as from the top of the repository
        base = root if path.startswith("/") else os.path.join(root, os.path.dirname(rel))
        full = os.path.normpath(os.path.join(base, path.lstrip("/")))
    if not (full == root or full.startswith(root + os.sep)):
        return True
    if os.path.relpath(full, root).split(os.sep)[0].lower() == "private":
        return True
    return must_exist and not os.path.exists(full)


def link_check(out):
    problems = []
    root = os.path.abspath(out)
    for rel in sorted(all_files(out)):
        if not rel.lower().endswith(".md"):
            continue
        try:
            with open(os.path.join(out, rel), encoding="utf-8") as f:
                lines = f.read().splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(lines, 1):
            if any(bad_link(t, rel, root, must) for t, must in link_targets(line)):
                problems.append("%s:%d: link to a file that isn't in the public copy" % (rel, n))
    return problems


def symlinks(out):
    """Number of symbolic links anywhere in the copy (files or directories)."""
    found = 0
    for d, dirs, names in os.walk(out):
        for n in dirs + names:
            if os.path.islink(os.path.join(d, n)):
                found += 1
    return found


def build(ref, out, patterns, messages=(), repo="."):
    if os.path.exists(out) and (os.path.islink(out) or not os.path.isdir(out) or os.listdir(out)):
        raise PublishError("output directory is not empty")      # never delete what isn't ours
    try:
        return _build(ref, out, patterns, messages, repo)
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)     # a failed build leaves nothing usable
        raise


def _build(ref, out, patterns, messages, repo):
    archive(ref, out, repo)
    remove_private(out)
    # A link's target is text no check reads, and following it could read files
    # from outside the copy: refuse links outright (fail closed, path withheld).
    n = symlinks(out)
    if n:
        raise PublishError("the public copy contains %d symbolic link(s); they are not allowed" % n)
    words, name_hit = wordlist_check(out, patterns, list(messages))
    # Any other check could print a flagged file name: report only these, and stop.
    if name_hit:
        raise PublishError("the public copy failed its checks:\n  " + "\n  ".join(words))
    problems = check_repo.check(out, strict=True) + words + link_check(out)
    if problems:
        raise PublishError("the public copy failed its checks:\n  " + "\n  ".join(problems))
    return sorted(all_files(out))


def explain(root, wordlist_path):
    """Local diagnosis for the owner: which word-list LINE NUMBER matches which
    file:line. Never prints the pattern or the matched text, nor a matching file name."""
    with open(wordlist_path, encoding="utf-8-sig") as f:      # as load_wordlist: a BOM hides nothing
        lines = [(n, l.strip()) for n, l in enumerate(f, 1) if l.strip() and not l.strip().startswith("#")]
    pats = [(n, re.compile(l, re.I)) for n, l in lines]
    hits = 0
    for index, rel in enumerate(sorted(check_repo.files_in(root)), 1):
        if check_repo.skipped(rel):
            continue
        named = False
        for n, p in pats:
            if p.search(rel):
                print("word-list line %d matches the NAME of file #%d (in sorted order)" % (n, index))
                hits += 1
                named = True
        named = named or any(True for _ in check_repo.scan_text(rel))     # an email, IP or MAC
        label = "file #%d (in sorted order)" % index if named else rel
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as f:
                for ln, text in enumerate(f, 1):
                    for n, p in pats:
                        if p.search(text):
                            print("word-list line %d matches %s:%d" % (n, label, ln))
                            hits += 1
        except (UnicodeDecodeError, OSError):
            continue
    print("explain: %d match(es)" % hits)
    return 1 if hits else 0


def main(argv):
    args = argv[1:]
    if args[:1] == ["--explain"]:
        if len(args) < 2 or not os.path.isfile(args[1]):
            print("usage: build_public.py --explain WORDLIST_FILE [DIR]", file=sys.stderr)
            return 2
        return explain(args[2] if len(args) > 2 else ".", args[1])
    try:
        ref, out = args[0], args[1]
        wl = args[args.index("--wordlist") + 1] if "--wordlist" in args else None
        msgs = [args[i + 1] for i, a in enumerate(args) if a == "--message"]
        patterns = load_wordlist(wl, os.environ.get("BRIDGE_WORDLIST"))
        files = build(ref, out, patterns, msgs)
    except (PublishError, IndexError, subprocess.CalledProcessError) as e:
        print("build_public: STOPPED, nothing is published.\n%s" % e, file=sys.stderr)
        return 1
    except (OSError, UnicodeDecodeError):
        print("build_public: STOPPED, nothing is published.\n"
              "an input could not be read (details withheld)", file=sys.stderr)
        return 1
    print("build_public: OK, %d files in %s" % (len(files), out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
