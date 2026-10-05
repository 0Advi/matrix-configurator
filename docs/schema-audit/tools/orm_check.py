#!/usr/bin/env python3
"""ORM-vs-database fit check: does every table/column the app's SQLAlchemy models map exist in a
given database? (The app SELECTs every mapped column, so a missing one 500s that model's queries.)

Loads Matrix-bd's backend/app/db/base.py + models.py directly (stub `app` / `app.db` packages) so the
app's settings/engine are never imported. Read-only against the target DB.

usage: AUDIT_PGPASS_FILE=... python3 orm_check.py <path-to-backend> <dbname> [--json OUT]
"""
import asyncio
import importlib.util
import json
import os
import sys
import types

backend, dbname = sys.argv[1], sys.argv[2]
out = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None

for name in ("app", "app.db"):
    mod = types.ModuleType(name)
    mod.__path__ = [os.path.join(backend, *name.split("."))]
    sys.modules[name] = mod


def _load(modname, path):
    spec = importlib.util.spec_from_file_location(modname, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[modname] = m
    spec.loader.exec_module(m)
    return m


base = _load("app.db.base", os.path.join(backend, "app/db/base.py"))
_load("app.db.models", os.path.join(backend, "app/db/models.py"))
meta = base.Base.metadata


async def main():
    import asyncpg
    pw = open(os.environ["AUDIT_PGPASS_FILE"]).read().strip()
    conn = await asyncpg.connect(host="127.0.0.1", port=int(os.environ.get("AUDIT_PGPORT", "54339")),
                                 user="postgres", password=pw, database=dbname)
    try:
        rows = await conn.fetch("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'")
    finally:
        await conn.close()
    db = {}
    for r in rows:
        db.setdefault(r["table_name"], set()).add(r["column_name"])
    missing_tables, missing_cols = [], []
    for tname, table in sorted(meta.tables.items()):
        if tname not in db:
            missing_tables.append(tname)
            continue
        for col in table.columns:
            if col.name not in db[tname]:
                missing_cols.append(f"{tname}.{col.name}")
    res = {"database": dbname, "orm_tables": len(meta.tables), "missing_tables": missing_tables,
           "missing_columns": missing_cols}
    print(json.dumps(res, indent=1))
    if out:
        json.dump(res, open(out, "w"), indent=1)


asyncio.run(main())
