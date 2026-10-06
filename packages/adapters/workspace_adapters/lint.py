"""Static checks for adapter source (Task 5) — run in CI before an adapter version can be installed.

    python -m workspace_adapters.lint path/to/adapter.py [...]

Rules (each finding: file:line code message):
  AD001  database / ORM / SQL access              no driver imports, no SQL strings — adapters get snapshots, not tables
  AD002  hidden role check                        no comparisons on role/roles/is_admin/tier names — authorisation is the runtime's
  AD003  hard-coded workspace / tenant specifics  no UUID literals, no workspace keys (ws_…), no tenant names — use adapter config
  AD004  process-global mutable state             no `global`, no module-level dict/list/set later mutated — hooks are stateless
  AD005  network / filesystem / subprocess        only through context APIs (none exist today)
  AD006  hidden cross-module write                no Command(module=<literal other than ctx.case.module>)
  AD007  wall clock / randomness                  use ctx.now; no random/uuid4/time.time/datetime.now — outcomes must replay
"""
from __future__ import annotations

import ast
import re
import sys
from typing import List, Tuple

DB_MODULES = {"sqlalchemy", "psycopg", "psycopg2", "asyncpg", "sqlite3", "pymysql", "django", "peewee", "databases"}
IO_MODULES = {"requests", "httpx", "urllib", "urllib3", "aiohttp", "socket", "subprocess", "shutil", "ftplib", "smtplib"}
ROLE_WORDS = {"role", "roles", "real_role", "role_in_module", "is_admin", "is_supervisor", "is_business_admin", "tier_role"}
ROLE_VALUES = {"business_admin", "supervisor", "executive", "observer", "workspace_admin", "platform_admin"}
SQL_RE = re.compile(r"\b(select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b", re.I | re.S)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
WS_RE = re.compile(r"^ws_[a-z0-9_]+$")
CLOCK_CALLS = {("random", None), ("uuid", "uuid4"), ("uuid", "uuid1"), ("time", "time"), ("datetime", "now"),
               ("datetime", "utcnow"), ("date", "today"), ("secrets", None)}

Finding = Tuple[int, str, str]


def _names(node: ast.AST) -> List[str]:
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.append(n.id)
        elif isinstance(n, ast.Attribute):
            out.append(n.attr)
        elif isinstance(n, ast.Constant) and isinstance(n.value, str):
            out.append(n.value)
    return out


def lint_source(src: str) -> List[Finding]:
    tree = ast.parse(src)
    f: List[Finding] = []
    module_mutables = set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, (ast.Dict, ast.List, ast.Set, ast.Call)):
            if isinstance(node.value, ast.Call) and not (isinstance(node.value.func, ast.Name) and node.value.func.id in ("dict", "list", "set")):
                continue
            module_mutables |= {t.id for t in node.targets if isinstance(t, ast.Name)}
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module or ""]
            for m in mods:
                root = m.split(".")[0]
                if root in DB_MODULES:
                    f.append((n.lineno, "AD001", f"imports database module {m!r}"))
                if root in IO_MODULES:
                    f.append((n.lineno, "AD005", f"imports network/IO module {m!r}"))
                if root in ("random", "secrets"):
                    f.append((n.lineno, "AD007", f"imports {root!r}: outcomes must replay; use ctx inputs"))
        elif isinstance(n, ast.Constant) and isinstance(n.value, str):
            if SQL_RE.search(n.value):
                f.append((n.lineno, "AD001", "SQL in a string literal"))
            if UUID_RE.match(n.value.strip()):
                f.append((n.lineno, "AD003", f"UUID literal {n.value!r}: tenant/record ids must come from config or context"))
            if WS_RE.match(n.value.strip()):
                f.append((n.lineno, "AD003", f"workspace key literal {n.value!r}: use adapter config"))
        elif isinstance(n, ast.Compare):
            words = set(_names(n))
            if words & ROLE_WORDS or (words & ROLE_VALUES and any(isinstance(c, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)) for c in n.ops)):
                f.append((n.lineno, "AD002", "role comparison — the runtime authorises; adapters never branch on roles"))
        elif isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant) and n.slice.value in ROLE_WORDS:
            f.append((n.lineno, "AD002", f"reads {n.slice.value!r} — adapters never see or use roles"))
        elif isinstance(n, ast.Attribute) and n.attr in ROLE_WORDS:
            f.append((n.lineno, "AD002", f"reads .{n.attr} — adapters never see or use roles"))
        elif isinstance(n, ast.Global):
            f.append((n.lineno, "AD004", "`global` statement: hooks must be stateless"))
        elif isinstance(n, ast.Call):
            fn = n.func
            if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) and fn.value.id in module_mutables \
                    and fn.attr in ("append", "update", "add", "setdefault", "pop", "extend", "clear", "__setitem__"):
                f.append((n.lineno, "AD004", f"mutates module-level {fn.value.id!r}: hooks must be stateless"))
            if isinstance(fn, ast.Name) and fn.id == "open":
                f.append((n.lineno, "AD005", "file access via open()"))
            if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name):
                for mod, attr in CLOCK_CALLS:
                    if fn.value.id == mod and (attr is None or fn.attr == attr):
                        f.append((n.lineno, "AD007", f"{mod}.{fn.attr}(): use ctx.now / ctx.event_id"))
            if isinstance(fn, ast.Attribute) and fn.attr in ("now", "utcnow", "today") and isinstance(fn.value, ast.Attribute) \
                    and fn.value.attr in ("datetime", "date"):
                f.append((n.lineno, "AD007", f"{fn.value.attr}.{fn.attr}(): use ctx.now"))
            if isinstance(fn, ast.Name) and fn.id == "Command":
                for kw in n.keywords:
                    if kw.arg == "module" and isinstance(kw.value, ast.Constant):
                        f.append((n.lineno, "AD006", f"Command(module={kw.value.value!r}) literal: act only on ctx.case.module; "
                                                     "reach other modules with events"))
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id in module_mutables:
                    f.append((n.lineno, "AD004", f"writes module-level {t.value.id!r}: hooks must be stateless"))
    seen, out = set(), []
    for x in sorted(f):
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def main(argv=None) -> int:
    paths = (argv if argv is not None else sys.argv[1:])
    bad = 0
    for p in paths:
        for line, code, msg in lint_source(open(p, encoding="utf-8").read()):
            print(f"{p}:{line}: {code} {msg}")
            bad += 1
    print(f"{bad} finding(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
