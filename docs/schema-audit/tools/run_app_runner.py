#!/usr/bin/env python3
"""Execute the REAL Matrix-bd startup functions — `_apply_pending_migrations()` (ledger runner,
incl. its baseline branch) and `_verify_schema()` — against a throwaway database, without importing
the app. The functions (and their helpers) are lifted verbatim from backend/app/main.py via `ast`
and run with the app's own globals rebound:  engine -> an async engine on the throwaway DB,
_MIGRATION_DIR -> the directory given, log -> a capturing logger. `raise SystemExit(1)` inside
_verify_schema is reported as FAIL.

usage: AUDIT_PGPASS_FILE=... python3 run_app_runner.py MAIN_PY DBNAME MIGRATION_DIR [--verify-only]
"""
import ast
import asyncio
import logging
import os
import sys
from urllib.parse import quote

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import create_async_engine

main_py, dbname, migdir = sys.argv[1], sys.argv[2], sys.argv[3]
verify_only = "--verify-only" in sys.argv

WANTED = {"_sql_code_before_comment", "_parse_sql_statements", "_file_checksum",
          "_apply_pending_migrations", "_verify_schema"}
tree = ast.parse(open(main_py, encoding="utf-8").read())
nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in WANTED]
assert {n.name for n in nodes} == WANTED, "runner functions not found"

records = []


class _Capture(logging.Handler):
    def emit(self, record):
        records.append((record.levelname, record.getMessage().splitlines()[0][:300]))


log = logging.getLogger("matrix.api.audit-replay")
log.setLevel(logging.INFO)
log.addHandler(_Capture())
log.propagate = False

pw = open(os.environ["AUDIT_PGPASS_FILE"]).read().strip()
port = os.environ.get("AUDIT_PGPORT", "54339")
engine = create_async_engine(f"postgresql+asyncpg://postgres:{quote(pw, safe='')}@127.0.0.1:{port}/{dbname}")

import hashlib  # noqa: E402  (used by _file_checksum)

ns = {"os": os, "hashlib": hashlib, "text": text, "SQLAlchemyError": SQLAlchemyError,
      "engine": engine, "log": log, "_MIGRATION_DIR": os.path.abspath(migdir)}
exec(compile(ast.Module(body=nodes, type_ignores=[]), main_py, "exec"), ns)  # noqa: S102


async def main():
    rc = 0
    try:
        if not verify_only:
            await ns["_apply_pending_migrations"]()
        try:
            await ns["_verify_schema"]()
            print("_verify_schema: PASS")
        except SystemExit as exc:
            rc = 1
            print(f"_verify_schema: FAIL (SystemExit {exc.code})")
    finally:
        await engine.dispose()
    for lvl, msg in records:
        print(f"[{lvl}] {msg}")
    return rc


sys.exit(asyncio.run(main()))
