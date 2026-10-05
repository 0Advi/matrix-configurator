#!/usr/bin/env python3
"""Fresh-database bootstrap for the Matrix sandbox (app-stack/reset-db.sh calls this).

Run with the BACKEND venv's python (it imports the app's own migration helpers):

    app/backend/.venv/bin/python app-stack/bootstrap/bootstrap_db.py [--report DIR]

Reads DATABASE_URL from app/backend/.env (via the app's own Settings), so it can
only ever target the database the sandbox backend uses (loopback, port 54330).

Path (why: see app-stack/README.md "Bootstrap path"):

  1. DROP + CREATE the app database (refuses anything that is not localhost).
  2. db-init/00-supabase-shim.sql   — roles, extensions, auth.jwt() ...
  3. backend/database/schema.sql     — the repo's snapshot "regenerated to match
                                       the live database" (2026-06-13, hand-
                                       maintained since). Loaded verbatim, one txn.
  4. Every migration file, in the runner's order, replayed ONCE on top of the
     snapshot with the app's own parser (`app.main._parse_sql_statements`),
     one transaction per statement, failures tolerated — i.e. exactly what the
     pre-ledger "always-run" runner did against the live DB on every boot.
     Files marked HOLD (not applied in production) are recorded but NOT run.
  5. Every file is written to public.schema_migrations with the app's own
     checksum (`app.main._file_checksum`), so on boot the runner finds a
     complete ledger, applies nothing, and `_verify_schema` runs against the
     result.

A catalog snapshot is taken after step 3 and after step 4; the difference is
the drift between schema.sql and the migrations, written to the report dir.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sys
from urllib.parse import urlparse

HERE = pathlib.Path(__file__).resolve().parent
STACK = HERE.parent
ROOT = STACK.parent
BACKEND = ROOT / "app" / "backend"
SHIM = STACK / "db-init" / "00-supabase-shim.sql"
SCHEMA = BACKEND / "database" / "schema.sql"

# Migrations that production never executed. Recorded in the ledger (as the
# production baseline did) but not run.
HOLD = {
    # "DESTRUCTIVE, NOT YET APPLIED ... HOLD: run this only with explicit authorization"
    "202606145_drop_legacy_project_budget.sql",
}

# Make `import app...` resolve to the sandbox backend and its .env.
os.chdir(BACKEND)
sys.path.insert(0, str(BACKEND))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.exc import SQLAlchemyError  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.main import _MIGRATION_DIR, _file_checksum, _parse_sql_statements  # noqa: E402

SNAPSHOT_SQL = {
    "tables": """SELECT relname || ':' || relkind::text AS k, '' AS v FROM pg_class
                  WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','v','m','p')""",
    "columns": """SELECT table_name || '.' || column_name AS k,
                         concat_ws(' ', udt_name, CASE WHEN is_nullable='NO' THEN 'NOT NULL' END,
                                   'default=' || column_default) AS v
                    FROM information_schema.columns WHERE table_schema = 'public'""",
    "constraints": """SELECT conrelid::regclass::text || ' :: ' || pg_get_constraintdef(oid, true) AS k,
                             conname || CASE WHEN convalidated THEN '' ELSE ' (NOT VALID)' END AS v
                        FROM pg_constraint WHERE connamespace = 'public'::regnamespace""",
    "indexes": """SELECT regexp_replace(indexdef, 'INDEX \\S+ ON', 'INDEX ON') AS k, indexname AS v
                    FROM pg_indexes WHERE schemaname = 'public'""",
    "rls_enabled": """SELECT relname AS k, '' AS v FROM pg_class
                       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity""",
    "policies": """SELECT tablename || '.' || policyname AS k,
                          concat_ws(' | ', cmd, qual, with_check) AS v
                     FROM pg_policies WHERE schemaname = 'public'""",
    "functions": """SELECT proname || '(' || pg_get_function_identity_arguments(oid) || ')' AS k,
                           md5(prosrc) AS v
                      FROM pg_proc WHERE pronamespace = 'public'::regnamespace""",
    "enum_types": """SELECT typname AS k, '' AS v FROM pg_type
                      WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'""",
    "anon_auth_table_grants": """SELECT grantee || ' ' || privilege_type || ' ' || table_name AS k, '' AS v
                                   FROM information_schema.role_table_grants
                                  WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')""",
}


def _check_local(url: str) -> None:
    host = urlparse(url.replace("+asyncpg", "")).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        sys.exit(f"refusing: DATABASE_URL host {host!r} is not loopback")


async def _snapshot(conn) -> dict:
    snap = {}
    for name, sql in SNAPSHOT_SQL.items():
        rows = (await conn.execute(text(sql))).all()
        snap[name] = {}
        for k, v in rows:
            # Constraint keys can repeat (same def, different names) — keep all.
            snap[name].setdefault(k, []).append(v or "")
    return snap


def _diff(a: dict, b: dict) -> dict:
    out = {}
    for cat in SNAPSHOT_SQL:
        A, B = a.get(cat, {}), b.get(cat, {})
        added = {k: B[k] for k in B.keys() - A.keys()}
        removed = {k: A[k] for k in A.keys() - B.keys()}
        changed = {k: {"before": A[k], "after": B[k]} for k in A.keys() & B.keys() if sorted(A[k]) != sorted(B[k])}
        if added or removed or changed:
            out[cat] = {"added": dict(sorted(added.items())),
                        "removed": dict(sorted(removed.items())),
                        "changed": dict(sorted(changed.items()))}
    return out


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default=str(STACK / "run" / "bootstrap"))
    args = ap.parse_args()
    report_dir = pathlib.Path(args.report)
    report_dir.mkdir(parents=True, exist_ok=True)

    url = settings.database_url
    _check_local(url)
    dbname = urlparse(url.replace("+asyncpg", "")).path.lstrip("/")
    admin_url = url.rsplit("/", 1)[0] + "/postgres"

    # 1. drop + create
    admin = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as c:
        await c.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                             "WHERE datname = :d AND pid <> pg_backend_pid()"), {"d": dbname})
        await c.exec_driver_sql(f'DROP DATABASE IF EXISTS "{dbname}"')
        await c.exec_driver_sql(f'CREATE DATABASE "{dbname}"')
    await admin.dispose()
    print(f"[1/5] recreated database {dbname}")

    # Raw asyncpg connection for multi-statement scripts (simple query protocol).
    import asyncpg
    raw_dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    raw = await asyncpg.connect(raw_dsn)
    try:
        await raw.execute(SHIM.read_text(encoding="utf-8"))
        print("[2/5] applied db-init/00-supabase-shim.sql")
    finally:
        await raw.close()

    # New connection so the database-level search_path set by the shim applies.
    raw = await asyncpg.connect(raw_dsn)
    try:
        async with raw.transaction():
            await raw.execute(SCHEMA.read_text(encoding="utf-8"))
        print("[3/5] loaded backend/database/schema.sql")
    finally:
        await raw.close()

    engine = create_async_engine(url)
    async with engine.connect() as conn:
        async with conn.begin():
            snap_schema = await _snapshot(conn)

        # 4. replay migrations exactly like the pre-ledger runner (statement-level txns)
        files = sorted(f for f in os.listdir(_MIGRATION_DIR) if f.endswith(".sql"))
        async with conn.begin():
            await conn.exec_driver_sql(
                """CREATE TABLE IF NOT EXISTS public.schema_migrations (
                       filename   text PRIMARY KEY,
                       checksum   text        NOT NULL,
                       applied_at timestamptz NOT NULL DEFAULT now());"""
            )
        per_file = []
        retry: list = []
        for fn in files:
            raw_sql = pathlib.Path(_MIGRATION_DIR, fn).read_text(encoding="utf-8")
            entry = {"file": fn, "statements": 0, "ok": 0, "failed": [], "held": fn in HOLD}
            if fn not in HOLD:
                for stmt in _parse_sql_statements(raw_sql):
                    if not stmt:
                        continue
                    entry["statements"] += 1
                    try:
                        async with conn.begin():
                            await conn.exec_driver_sql(stmt)
                        entry["ok"] += 1
                    except SQLAlchemyError as exc:
                        orig = getattr(exc, "orig", exc)
                        msg = str(orig).splitlines()[0][:300]
                        first = next((ln for ln in stmt.splitlines()
                                      if ln.strip() and not ln.strip().startswith("--")), "")[:160]
                        entry["failed"].append({"stmt": first, "error": f"{type(orig).__name__}: {msg}"})
                        retry.append((entry["failed"][-1], stmt))
            async with conn.begin():
                await conn.execute(
                    text("INSERT INTO public.schema_migrations (filename, checksum) VALUES (:f, :c) "
                         "ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum"),
                    {"f": fn, "c": _file_checksum(raw_sql)},
                )
            per_file.append(entry)
        n_stmt = sum(e["statements"] for e in per_file)
        n_ok = sum(e["ok"] for e in per_file)
        print(f"[4/5] replayed {len(files)} migration files: {n_ok}/{n_stmt} statements applied, "
              f"{n_stmt - n_ok} tolerated failures, {len(HOLD)} held")

        # 4b. Second pass over the failed statements only — the old runner re-ran
        #     every file on EVERY boot, so a statement that failed only because a
        #     later file defines its dependency (e.g. a policy using
        #     get_current_tenant_id(), defined in 20260802) succeeded on the next
        #     boot. CREATE INDEX CONCURRENTLY can never succeed inside the runner's
        #     per-statement transaction (202606133 says to run it with autocommit),
        #     so those are retried with autocommit.
        recovered = 0
        for item, stmt in retry:
            autocommit = "ActiveSQLTransactionError" in item["error"]
            try:
                if autocommit:
                    ac = await asyncpg.connect(raw_dsn)  # no implicit transaction
                    try:
                        await ac.execute(stmt)
                    finally:
                        await ac.close()
                else:
                    async with conn.begin():
                        await conn.exec_driver_sql(stmt)
                item["second_pass"] = "ok (autocommit)" if autocommit else "ok"
                recovered += 1
            except (SQLAlchemyError, asyncpg.PostgresError) as exc:
                orig = getattr(exc, "orig", exc)
                item["second_pass"] = f"failed: {type(orig).__name__}: {str(orig).splitlines()[0][:200]}"
        print(f"      second pass: {recovered}/{len(retry)} previously-failed statements now applied; "
              f"{len(retry) - recovered} remain failed (see migration-replay.json)")

        async with conn.begin():
            snap_final = await _snapshot(conn)
            ledger = (await conn.execute(text("SELECT count(*) FROM public.schema_migrations"))).scalar()
    await engine.dispose()
    print(f"[5/5] ledger rows: {ledger} (files on disk: {len(files)})")

    drift = _diff(snap_schema, snap_final)
    (report_dir / "migration-replay.json").write_text(json.dumps(per_file, indent=2))
    (report_dir / "drift-schema-sql-vs-migrations.json").write_text(json.dumps(drift, indent=2))
    (report_dir / "catalog-final.json").write_text(json.dumps(snap_final, indent=2, sort_keys=True))
    summary = {cat: {k: len(v) for k, v in d.items()} for cat, d in drift.items()}
    print("drift (schema.sql -> after migrations):", json.dumps(summary))
    print(f"reports: {report_dir}")
    return 0 if ledger == len(files) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
