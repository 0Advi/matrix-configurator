#!/usr/bin/env python3
"""Extract the route -> role/module guard table from Matrix-bd's FastAPI routers.

READ-ONLY: every file is read with `git -C <repo> show <ref>:<path>` (no checkout,
no working-tree access, GIT_OPTIONAL_LOCKS=0). Prints JSON to stdout.

    python3 scripts/route_guards.py /Users/aditya/Desktop/bd/Matrix-bd origin/main
"""
import ast
import json
import os
import re
import subprocess
import sys

REPO = sys.argv[1] if len(sys.argv) > 1 else "/Users/aditya/Desktop/bd/Matrix-bd"
REF = sys.argv[2] if len(sys.argv) > 2 else "origin/main"
ENV = dict(os.environ, GIT_OPTIONAL_LOCKS="0")


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], check=True, capture_output=True, text=True, env=ENV).stdout


def guards_in(node_src, aliases):
    res = []
    for m in re.finditer(r"require_(real_role|role|module)\(([^)]*)\)", node_src):
        kind, args = m.group(1), m.group(2)
        vals = [a.strip().replace("Role.", "").lower().strip("\"'") for a in args.split(",") if a.strip()]
        res.append({"require_" + kind: vals})
    for name, g in aliases.items():
        if re.search(r"\b" + re.escape(name) + r"\b", node_src):
            res.extend(g)
    return res


def main():
    sha = git("rev-parse", REF).strip()
    files = [f for f in git("ls-tree", "-r", "--name-only", sha, "backend/app/routers/").split("\n")
             if f.endswith(".py") and not f.endswith("__init__.py")]
    out = []
    for path in sorted(files):
        tree = ast.parse(git("show", f"{sha}:{path}"))
        prefix, aliases = "", {}
        for n in tree.body:
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and ast.unparse(n.value.func) == "APIRouter":
                for kw in n.value.keywords:
                    if kw.arg == "prefix":
                        prefix = ast.literal_eval(kw.value)
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                src = ast.unparse(n.value)
                if "require_" in src:
                    aliases[n.targets[0].id] = guards_in(src, {})
        for n in ast.walk(tree):
            if not isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            for d in n.decorator_list:
                if (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                        and ast.unparse(d.func.value) == "router"
                        and d.func.attr in ("get", "post", "put", "patch", "delete")):
                    route = ast.literal_eval(d.args[0]) if d.args else ""
                    guards = []
                    for a in n.args.args + n.args.kwonlyargs:
                        if a.annotation is not None:
                            guards.extend(guards_in(ast.unparse(a.annotation), aliases))
                    roles = sorted({r for g in guards for k, v in g.items() if k in ("require_role", "require_real_role") for r in v})
                    mods = sorted({r for g in guards for k, v in g.items() if k == "require_module" for r in v})
                    out.append({
                        "method": d.func.attr.upper(),
                        "path": "/api" + prefix + route,
                        "handler": n.name,
                        "roles": roles,
                        "modules": mods,
                        "realRoleOnly": any("require_real_role" in g for g in guards),
                        "source": f"{path}:{n.lineno}",
                        "doc": (ast.get_docstring(n) or "").split("\n")[0][:160],
                    })
    json.dump({"sha": sha, "ref": REF, "routes": out}, sys.stdout, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
