"""Checks that need no browser: every script parses, and every local file a page points at exists."""
import os
import re
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.environ.get("AS360_SITE") or os.path.join(ROOT, "site")      # AS360_SITE: test the checker itself on a copy
SERVER_ROUTES = ("/api/", "/files/", "/embed/")      # served by the Worker, not by site/
EXTERNAL = re.compile(r"^(https?:)?//|^data:|^#|^mailto:|^tel:|^javascript:")


def run():
    problems = []
    node = shutil.which("node")
    names = sorted(os.listdir(SITE))
    if node:
        for f in names:
            if f.endswith(".js"):
                r = subprocess.run([node, "--check", os.path.join(SITE, f)], capture_output=True, text=True)
                if r.returncode:
                    problems.append(f"{f}: does not parse: {(r.stderr.strip().splitlines() or ['?'])[0]}")
    else:
        problems.append("node is not installed, so the JavaScript syntax check could not run")
    for f in names:
        if not f.endswith(".html"):
            continue
        html = open(os.path.join(SITE, f), encoding="utf-8").read()
        for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
            if EXTERNAL.match(ref) or ref.startswith(SERVER_ROUTES) or "${" in ref:   # ${...} = built by the page at run time
                continue
            path = ref.split("?")[0].split("#")[0]
            if not path or path == "/":
                continue
            if not os.path.isfile(os.path.join(SITE, path.lstrip("/"))) and not os.path.isfile(os.path.join(SITE, path.lstrip("/") + ".html")):
                problems.append(f"{f}: points at {ref}, which is not in site/")
    return problems
