#!/usr/bin/python3 -I
"""Prepare and push the single public commit of a release.

  publish_public.py prepare PUBLIC_CLONE COPY VERSION [--first-base SHA]
  publish_public.py push PUBLIC_CLONE VERSION

prepare makes the commit "claude-code-discord-bridge X.Y.Z" and the annotated
tag vX.Y.Z in PUBLIC_CLONE, both authored and committed by the bot identity
(never the maintainer's email), in UTC, on top of the previous release. The whole
tree is replaced by COPY, so files deleted since the last release are deleted
publicly too. Nothing leaves the machine.

push pushes the branch and the tag together (--atomic). It does nothing if the
remote already holds exactly that commit and tag, so a re-run after a
half-done publish finishes the public side once, and a second run is a no-op.

--first-base: only for the FIRST release, when the public repo already has
commits (for example a README that GitHub made): publish on top of exactly
that commit. An empty public repo needs none.

Checks before anything is committed:
  * the public repo hasn't moved: its HEAD sits exactly on the commit its
    newest v* tag points at, and VERSION is newer than that tag. For the very
    first release (no tags yet), the repo must be empty (no commits and no
    refs), or --first-base must name its HEAD;
  * if vVERSION already exists there with the same content, there is nothing
    to prepare; with different content, the run stops;
  * the staged tree is exactly COPY: the same paths, modes and content. No
    ignore rule (the maintainer's, the clone's or the copy's .gitignore) drops a file.

Python 3.9 compatible (the first publish runs on Apple's /usr/bin/python3).
"""
import os
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

BOT = "claude-code-discord-bridge release <41898282+github-actions[bot]@users.noreply.github.com>"
NAME = "claude-code-discord-bridge"


class PublishError(Exception):
    pass


def bot_env():
    name, email = BOT[:-1].split(" <", 1)
    return {"GIT_AUTHOR_NAME": name, "GIT_COMMITTER_NAME": name,
            "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_EMAIL": email,
            "TZ": "UTC"}                  # the maintainer's time zone stays off the public record


def git(repo, *args, **kw):
    env = dict(os.environ)
    env.update(kw.get("env") or {})
    pre = []
    if kw.get("isolated"):
        # No config-borne leak of the maintainer (hooks, user.*, signing, templates, trailers).
        env.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                    "GIT_CONFIG_NOSYSTEM": "1"})
        pre = ["-c", "core.hooksPath=" + os.devnull, "-c", "commit.gpgsign=false",
               "-c", "tag.gpgsign=false", "-c", "core.excludesFile=" + os.devnull]
    cmd = ["git", "-C", repo] + pre + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, input=kw.get("input"))
    if p.returncode != 0:
        raise PublishError("git %s failed: %s" % (" ".join(args[:2]), p.stderr.strip()[-300:]))
    return p.stdout.strip()


def vkey(tag):
    return tuple(int(x) for x in tag[1:].split("."))


def release_tags(repo):
    tags = [t for t in git(repo, "tag", "--list", "v*").split() if re.fullmatch(r"v\d+\.\d+\.\d+", t)]
    return sorted(tags, key=vkey)


def tree_of(repo, ref):
    return git(repo, "rev-parse", ref + "^{tree}")


def head_commit(repo):
    """HEAD's commit, or None in a clone of an empty repository (no commits and no refs)."""
    try:
        return git(repo, "rev-parse", "-q", "--verify", "HEAD^{commit}")
    except PublishError:
        pass
    if git(repo, "for-each-ref"):
        raise PublishError("the public clone has refs but no HEAD commit; nothing published")
    return None


def check_unmoved(repo, version, first_base=None):
    """Return "already-tagged", "first" or the previous tag; raise if the repo moved."""
    tags = release_tags(repo)
    head = head_commit(repo)
    newest = tags[-1] if tags else None
    if newest and vkey(newest) > vkey("v" + version):
        raise PublishError("%s is older than the public %s" % (version, newest))
    if not newest:
        if head is None:
            if first_base:
                raise PublishError("the public repo is empty, so there is no commit to "
                                   "acknowledge; run without --first-base")
            return "first"
        if not first_base:
            raise PublishError("the public repo has commits but no release tag. Check them; if "
                               "they may stay, run again with --first-base SHA (its HEAD)")
        # Allowed only if the public repo is EXACTLY at the commit the maintainer acknowledged.
        if len(first_base) < 7 or not head.startswith(first_base.lower()):
            raise PublishError("the public repo is not at the acknowledged commit %s"
                               % first_base[:12])
        return "first"
    if git(repo, "rev-parse", newest + "^{commit}") != head:
        raise PublishError("the public main branch is not on %s: someone committed there "
                           "directly; nothing published" % newest)
    if newest == "v" + version:
        return "already-tagged"
    return newest


def replace_tree(repo, copy):
    for name in os.listdir(repo):
        if name == ".git":
            continue
        p = os.path.join(repo, name)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
    for name in os.listdir(copy):
        src, dst = os.path.join(copy, name), os.path.join(repo, name)
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
    # The copy is the vetted file set: no ignore rule may drop a file from it.
    git(repo, "add", "-A", "--force", isolated=True)
    check_staged(repo, copy)


def copy_entries(repo, copy):
    """{path: (mode, blob)} for every file in COPY, as git would stage it. Anything that is not
    a regular file gets an entry that never matches."""
    copy = os.path.abspath(copy)              # git -C REPO would read a relative path from REPO
    entries, regular = {}, []
    for d, dirs, names in os.walk(copy):
        for n in dirs + names:
            full = os.path.join(d, n)
            rel = os.path.relpath(full, copy).replace(os.sep, "/")
            if n in dirs and not os.path.islink(full):
                continue
            if os.path.islink(full) or not os.path.isfile(full) or "\n" in full:
                entries[rel] = ("not a regular file", None)
                continue
            entries[rel] = ("100755" if os.stat(full).st_mode & 0o100 else "100644", None)
            regular.append(rel)
    if regular:
        paths = "".join(os.path.join(copy, rel) + "\n" for rel in regular)
        blobs = git(repo, "hash-object", "--no-filters", "--stdin-paths", input=paths,
                    isolated=True).split()
        for rel, blob in zip(regular, blobs):
            entries[rel] = (entries[rel][0], blob)
    return entries


def staged_entries(repo):
    entries = {}
    for item in git(repo, "ls-files", "-s", "-z", isolated=True).split("\0"):
        if item:
            meta, path = item.split("\t", 1)
            mode, blob, _stage = meta.split()
            entries[path] = (mode, blob)
    return entries


def check_staged(repo, copy):
    """Refuse unless the staged tree holds exactly COPY's files, modes and content. Names are
    never printed (one could hold a private value): only the count and positions."""
    want, have = copy_entries(repo, copy), staged_entries(repo)
    paths = sorted(set(want) | set(have))
    differ = [str(i) for i, p in enumerate(paths, 1) if want.get(p) != have.get(p)]
    if differ:
        raise PublishError("the staged public tree differs from the copy in %d file(s) (number %s "
                           "in the sorted list of both trees' paths); nothing committed"
                           % (len(differ), ", ".join(differ[:10])))


def prepare(repo, copy, version, first_base=None):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise PublishError("version must look like X.Y.Z")
    if os.path.lexists(os.path.join(copy, ".git")):
        raise PublishError("the copy contains a .git entry; refusing to touch the clone")
    state = check_unmoved(repo, version, first_base)
    tag = "v" + version
    replace_tree(repo, copy)
    if state == "already-tagged":
        # Finish a half-done publish: the tag must hold exactly this content.
        staged = git(repo, "write-tree")
        git(repo, "reset", "-q", "--hard", "HEAD")
        if staged != tree_of(repo, tag):
            raise PublishError("%s already exists in the public repo with different content" % tag)
        return "exists"
    msg = "%s %s" % (NAME, version)
    git(repo, "commit", "-q", "--allow-empty", "--no-verify", "-m", msg,
        env=bot_env(), isolated=True)
    git(repo, "tag", "-a", tag, "-m", msg, env=bot_env(), isolated=True)
    return "prepared"


def remote_ref(repo, ref):
    out = git(repo, "ls-remote", "origin", ref)
    return out.split()[0] if out else None


def push(repo, version):
    """Push main and the tag together; a no-op if the remote already has both."""
    tag = "v" + version
    if git(repo, "rev-parse", "HEAD") != git(repo, "rev-parse", tag + "^{commit}"):
        raise PublishError("HEAD of the public clone is not %s; nothing pushed" % tag)
    if (remote_ref(repo, "refs/heads/main") == git(repo, "rev-parse", "HEAD")
            and remote_ref(repo, "refs/tags/" + tag) == git(repo, "rev-parse", "refs/tags/" + tag)):
        return "unchanged"
    git(repo, "push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/" + tag)
    return "pushed"


def main(argv):
    usage = ("usage: publish_public.py prepare PUBLIC_CLONE COPY VERSION [--first-base SHA]\n"
             "       publish_public.py push PUBLIC_CLONE VERSION")
    try:
        if len(argv) >= 5 and argv[1] == "prepare":
            repo, copy, version = argv[2], argv[3], argv[4]
            rest = argv[5:]
            first_base = None
            if rest:
                if len(rest) != 2 or rest[0] != "--first-base":
                    raise PublishError(usage)
                first_base = rest[1]
            result = prepare(repo, copy, version, first_base)
            if result == "exists":
                print("publish_public: v%s is already in the public clone with this content" % version)
            else:
                print("publish_public: prepared %s %s locally; nothing pushed." % (NAME, version))
                print(git(repo, "show", "--stat", "--format=%an <%ae>%n%s", "HEAD")[:3000])
        elif len(argv) == 4 and argv[1] == "push":
            result = push(argv[2], argv[3])
            if result == "unchanged":
                print("publish_public: v%s is already pushed; nothing to do" % argv[3])
            else:
                print("publish_public: pushed %s %s (commit + tag v%s)" % (NAME, argv[3], argv[3]))
        else:
            raise PublishError(usage)
    except PublishError as e:
        print("publish_public: STOPPED, nothing published.\n%s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
