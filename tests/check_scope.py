"""Fails if a branch changed anything outside what Stage A is allowed to touch.
    python tests/check_scope.py a71c871        (compares HEAD with that commit)
Allowed: the four site files below, and anything under tests/. Never allowed: worker.py, bg_patch.py, deploy/, scripts/, .github/, requirements."""
import subprocess
import sys

ALLOWED_FILES = {"site/pano-archive.js", "site/pano-capture.js", "site/media-tools.js", "site/media.html"}
ALLOWED_PREFIX = ("tests/",)


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "HEAD~1"
    out = subprocess.run(["git", "diff", "--name-status", base, "HEAD"], capture_output=True, text=True, check=True).stdout.splitlines()
    bad = []
    for line in out:
        status, path = line.split("\t", 1)
        if not (path in ALLOWED_FILES or path.startswith(ALLOWED_PREFIX)):
            bad.append(line)
        if status.startswith("D"):
            bad.append("deleted: " + path)
    for line in out:
        print(line)
    if bad:
        print("OUT OF SCOPE:", *bad, sep="\n  ")
        sys.exit(1)
    print(f"scope OK: {len(out)} files, all inside the allowed list")


if __name__ == "__main__":
    main()
