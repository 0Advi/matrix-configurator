#!/usr/bin/env python3
"""F2 schema-audit harness (throwaway local Postgres only).

Subcommands
  createdb NAME [--template T]      create a database (drops it first if it exists)
  load NAME FILE...                 execute whole SQL files (simple-query protocol, one implicit txn each)
  replay NAME MIGDIR MAIN_PY OUT    replay every *.sql in MIGDIR with the REAL app runner semantics:
                                      * statements split by the app's OWN parser — the functions
                                        _sql_code_before_comment/_parse_sql_statements are lifted
                                        verbatim (via ast) from the given backend/app/main.py
                                      * files in sorted() filename order
                                      * each statement in its own transaction (so CREATE INDEX
                                        CONCURRENTLY fails exactly as it does under the runner)
                                      * a file is recorded in public.schema_migrations (sha256 of
                                        its text) only if all its statements succeeded
                                    writes a JSON log of every statement outcome to OUT
  introspect NAME OUT               catalog snapshot (tables/columns/constraints/indexes/RLS/policies/
                                    functions/views/types/triggers) as JSON
  diff A.json B.json                markdown diff of two snapshots
  sql NAME "SQL"                    run one statement, print rows (for evidence)

Connection: 127.0.0.1:${AUDIT_PGPORT:-54339}, user postgres, password read from the file named
in $AUDIT_PGPASS_FILE (never printed). Never point this at a real database.
"""
from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import os
import sys

import asyncpg

HOST = "127.0.0.1"
PORT = int(os.environ.get("AUDIT_PGPORT", "54339"))
if HOST not in ("127.0.0.1", "localhost"):
    raise SystemExit("refusing: this harness only talks to a loopback throwaway database")


def _password() -> str:
    with open(os.environ["AUDIT_PGPASS_FILE"], encoding="utf-8") as fh:
        return fh.read().strip()


async def _connect(db: str) -> asyncpg.Connection:
    return await asyncpg.connect(host=HOST, port=PORT, user="postgres", password=_password(), database=db)


def _load_runner_parser(main_py: str):
    """Lift the app's own statement splitter out of main.py without importing the app."""
    src = open(main_py, encoding="utf-8").read()
    tree = ast.parse(src)
    wanted = {"_sql_code_before_comment", "_parse_sql_statements"}
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
    if {n.name for n in nodes} != wanted:
        raise SystemExit(f"could not find runner parser functions in {main_py}")
    mod = ast.Module(body=nodes, type_ignores=[])
    ns: dict = {}
    exec(compile(mod, main_py, "exec"), ns)  # noqa: S102 — the repo's own code, read-only copy
    return ns["_parse_sql_statements"]


async def cmd_createdb(name: str, template: str | None = None) -> None:
    conn = await _connect("postgres")
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        if template:
            await conn.execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
        else:
            await conn.execute(f'CREATE DATABASE "{name}"')
        print(f"created database {name}" + (f" from template {template}" if template else ""))
    finally:
        await conn.close()


async def cmd_load(name: str, files: list[str]) -> int:
    conn = await _connect(name)
    rc = 0
    try:
        for f in files:
            sql = open(f, encoding="utf-8").read()
            try:
                await conn.execute(sql)
                print(f"OK   {os.path.basename(f)}")
            except Exception as exc:  # noqa: BLE001
                rc = 1
                print(f"FAIL {os.path.basename(f)}: {type(exc).__name__}: {exc}")
    finally:
        await conn.close()
    return rc


def _sa_url(db: str) -> str:
    from urllib.parse import quote
    return f"postgresql+asyncpg://postgres:{quote(_password(), safe='')}@{HOST}:{PORT}/{db}"


async def cmd_replay(name: str, migdir: str, main_py: str, out: str, label: str = "") -> None:
    """ALWAYS-RUN emulation (the 2026-07-10 runner, and the per-statement core of today's ledger
    runner): every file, every statement, each via SQLAlchemy exec_driver_sql inside its own
    conn.begin() — the exact driver path the app uses (SQLAlchemy 2.0.50 + asyncpg 0.31.0, the
    versions pinned in backend/requirements.lock.txt)."""
    from sqlalchemy import text
    from sqlalchemy.exc import SQLAlchemyError
    from sqlalchemy.ext.asyncio import create_async_engine

    parse = _load_runner_parser(main_py)
    files = sorted(f for f in os.listdir(migdir) if f.endswith(".sql"))
    engine = create_async_engine(_sa_url(name))
    log = {"database": name, "label": label, "files": []}
    try:
        async with engine.connect() as conn:
            async with conn.begin():
                await conn.exec_driver_sql(
                    "CREATE TABLE IF NOT EXISTS public.schema_migrations ("
                    " filename text PRIMARY KEY, checksum text NOT NULL,"
                    " applied_at timestamptz NOT NULL DEFAULT now())"
                )
            ok_files = failed_files = 0
            for fn in files:
                raw = open(os.path.join(migdir, fn), encoding="utf-8").read()
                stmts = [s for s in parse(raw) if s]
                entry = {"file": fn, "statements": len(stmts), "failed": []}
                for i, stmt in enumerate(stmts):
                    try:
                        async with conn.begin():
                            await conn.exec_driver_sql(stmt)
                    except SQLAlchemyError as exc:
                        orig = getattr(exc, "orig", exc)
                        entry["failed"].append({
                            "index": i,
                            "head": " ".join(stmt.split())[:160],
                            "error": f"{type(orig).__name__}: {str(orig).splitlines()[0][:220]}",
                        })
                if entry["failed"]:
                    failed_files += 1
                else:
                    ok_files += 1
                    async with conn.begin():
                        await conn.execute(
                            text("INSERT INTO public.schema_migrations (filename, checksum) VALUES (:f, :c) "
                                 "ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()"),
                            {"f": fn, "c": hashlib.sha256(raw.encode("utf-8")).hexdigest()},
                        )
                log["files"].append(entry)
            log["summary"] = {"files": len(files), "ok": ok_files, "with_failures": failed_files}
    finally:
        await engine.dispose()
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(log, fh, indent=1)
    s = log["summary"]
    print(f"replay {label or name}: {s['files']} files, {s['ok']} clean, {s['with_failures']} with failing statements")
    for e in log["files"]:
        for f in e["failed"]:
            print(f"  FAIL {e['file']} #{f['index']}: {f['error']}  <- {f['head'][:90]}")


INTROSPECT = {
    "columns": """
        SELECT c.table_name, c.column_name, c.data_type,
               CASE WHEN c.data_type IN ('numeric') THEN coalesce(c.numeric_precision::text,'') || ',' || coalesce(c.numeric_scale::text,'') ELSE '' END AS prec,
               c.udt_name, c.is_nullable, coalesce(c.column_default,'') AS dflt, c.is_generated,
               coalesce(c.generation_expression,'') AS gen
          FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
         WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
         ORDER BY 1,2""",
    "constraints": """
        SELECT rel.relname AS table_name, con.conname, con.contype::text AS contype,
               pg_get_constraintdef(con.oid) AS def, con.convalidated
          FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
          JOIN pg_namespace n ON n.oid=rel.relnamespace
         WHERE n.nspname='public' ORDER BY 1,2""",
    "indexes": """
        SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2""",
    "rls": """
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1""",
    "policies": """
        SELECT tablename, policyname, cmd, roles::text AS roles, coalesce(qual,'') AS qual,
               coalesce(with_check,'') AS with_check
          FROM pg_policies WHERE schemaname='public' ORDER BY 1,2""",
    "functions": """
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
               md5(pg_get_functiondef(p.oid)) AS body_md5
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.prokind='f'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')
         ORDER BY 1,2""",
    "views": """
        SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1""",
    "types": """
        SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
          FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
          JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
         GROUP BY 1 ORDER BY 1""",
    "triggers": """
        SELECT event_object_table AS table_name, trigger_name,
               string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events,
               action_timing, action_statement
          FROM information_schema.triggers WHERE trigger_schema='public'
         GROUP BY 1,2,4,5 ORDER BY 1,2""",
}


async def cmd_introspect(name: str, out: str) -> None:
    conn = await _connect(name)
    snap: dict = {"database": name}
    try:
        for key, q in INTROSPECT.items():
            snap[key] = [dict(r) for r in await conn.fetch(q)]
    finally:
        await conn.close()
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(snap, fh, indent=1, default=str)
    print(f"introspected {name}: " + ", ".join(f"{k}={len(v)}" for k, v in snap.items() if isinstance(v, list)))


def _keyed(snap: dict, kind: str) -> dict:
    out = {}
    for r in snap.get(kind, []):
        if kind == "columns":
            k = (r["table_name"], r["column_name"])
            v = f"{r['data_type']}{('(' + r['prec'] + ')') if r['prec'] and r['prec'] != ',' else ''} null={r['is_nullable']} default={r['dflt'] or '-'}" + (f" GENERATED({r['gen'][:40]}…)" if r['gen'] else "")
        elif kind == "constraints":
            k = (r["table_name"], r["conname"])
            v = f"[{r['contype']}] {r['def']}" + ("" if r["convalidated"] else " (NOT VALID)")
        elif kind == "indexes":
            k = (r["tablename"], r["indexname"]); v = r["indexdef"]
        elif kind == "rls":
            k = (r["relname"],); v = f"rls={r['relrowsecurity']}"
        elif kind == "policies":
            k = (r["tablename"], r["policyname"]); v = f"{r['cmd']} {r['roles']} USING({r['qual']}) CHECK({r['with_check']})"
        elif kind == "functions":
            k = (r["proname"], r["args"]); v = r["body_md5"]
        elif kind == "views":
            k = (r["table_name"],); v = "view"
        elif kind == "types":
            k = (r["typname"],); v = r["labels"]
        elif kind == "triggers":
            k = (r["table_name"], r["trigger_name"]); v = f"{r['action_timing']} {r['events']}"
        else:
            continue
        out[k] = v
    return out


def cmd_diff(a_path: str, b_path: str) -> None:
    a, b = json.load(open(a_path)), json.load(open(b_path))
    print(f"### `{a['database']}` (A) vs `{b['database']}` (B)\n")
    for kind in ["columns", "constraints", "indexes", "rls", "policies", "functions", "views", "types", "triggers"]:
        ka, kb = _keyed(a, kind), _keyed(b, kind)
        only_a = sorted(set(ka) - set(kb)); only_b = sorted(set(kb) - set(ka))
        changed = sorted(k for k in set(ka) & set(kb) if ka[k] != kb[k])
        if not (only_a or only_b or changed):
            print(f"- **{kind}**: identical ({len(ka)})")
            continue
        print(f"- **{kind}**: A={len(ka)} B={len(kb)} · only-A {len(only_a)} · only-B {len(only_b)} · differ {len(changed)}")
        for k in only_a:
            print(f"  - only A `{'.'.join(k)}`: {ka[k]}")
        for k in only_b:
            print(f"  - only B `{'.'.join(k)}`: {kb[k]}")
        for k in changed:
            print(f"  - differ `{'.'.join(k)}`:\n    - A: {ka[k]}\n    - B: {kb[k]}")
    print()


async def cmd_baseline(name: str, migdir: str) -> None:
    """Emulate the ledger runner's one-time BASELINE (main.py:309-336, first boot of d1e99c6 on
    2026-07-11): record every file present as applied, without executing it. Existing rows win."""
    files = sorted(f for f in os.listdir(migdir) if f.endswith(".sql"))
    conn = await _connect(name)
    try:
        added = 0
        for fn in files:
            raw = open(os.path.join(migdir, fn), encoding="utf-8").read()
            r = await conn.execute(
                "INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING",
                fn, hashlib.sha256(raw.encode("utf-8")).hexdigest())
            added += int(r.split()[-1])
        print(f"baseline {name}: {added} file(s) recorded without executing ({len(files)} present)")
    finally:
        await conn.close()


async def cmd_sql(name: str, sql: str) -> None:
    conn = await _connect(name)
    try:
        rows = await conn.fetch(sql)
        for r in rows:
            print(" | ".join(str(v) for v in r.values()))
        if not rows:
            print("(0 rows)")
    finally:
        await conn.close()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__); return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "createdb":
        tmpl = None
        if "--template" in args:
            i = args.index("--template"); tmpl = args[i + 1]; args = args[:i] + args[i + 2:]
        asyncio.run(cmd_createdb(args[0], tmpl)); return 0
    if cmd == "load":
        return asyncio.run(cmd_load(args[0], args[1:]))
    if cmd == "replay":
        asyncio.run(cmd_replay(args[0], args[1], args[2], args[3], args[4] if len(args) > 4 else "")); return 0
    if cmd == "introspect":
        asyncio.run(cmd_introspect(args[0], args[1])); return 0
    if cmd == "diff":
        cmd_diff(args[0], args[1]); return 0
    if cmd == "baseline":
        asyncio.run(cmd_baseline(args[0], args[1])); return 0
    if cmd == "sql":
        asyncio.run(cmd_sql(args[0], args[1])); return 0
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
