"""Runs the store SQL against a real PostgreSQL (13+).

Set STORE_TEST_DSN (default: postgresql://postgres@/postgres?host=/tmp&port=55432). Each test session
creates a fresh database, applies 0001 stub + 0002_store.sql TWICE (idempotency), and creates a
non-superuser role ``store_app`` to exercise row-level security.
"""
import json
import os
import uuid

import psycopg
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SQL = os.path.join(os.path.dirname(HERE), "sql")
EXAMPLE = os.path.join(os.path.dirname(os.path.dirname(HERE)), "manifest", "examples", "acme-retail.manifest.json")
DSN = os.environ.get("STORE_TEST_DSN", "postgresql://postgres@/postgres?host=/tmp&port=55432")

IDENTITY_STUB = """
CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, name text NOT NULL);
"""


@pytest.fixture(scope="session")
def dsn():
    name = "store_test_" + uuid.uuid4().hex[:8]
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
        c.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='store_app') THEN CREATE ROLE store_app LOGIN; END IF; END $$")
    db = DSN.replace("/postgres?", f"/{name}?")
    with psycopg.connect(db, autocommit=True) as c:
        c.execute(IDENTITY_STUB)
        sql = open(os.path.join(SQL, "0002_store.sql"), encoding="utf-8").read()
        c.execute(sql)
        c.execute(sql)  # idempotent
        c.execute("GRANT USAGE ON SCHEMA public TO store_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO store_app;"
                  "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO store_app;")
    yield db
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


@pytest.fixture
def conn(dsn):
    with psycopg.connect(dsn, autocommit=True) as c:
        yield c


@pytest.fixture
def app_conn(dsn):
    """Non-superuser connection: RLS applies."""
    with psycopg.connect(dsn.replace("postgres@", "store_app@"), autocommit=True) as c:
        yield c


@pytest.fixture
def manifest():
    return json.load(open(EXAMPLE, encoding="utf-8"))


@pytest.fixture
def ws(conn):
    key = "ws-" + uuid.uuid4().hex[:8]
    return conn.execute("INSERT INTO workspaces (key, name) VALUES (%s, %s) RETURNING id", (key, key)).fetchone()[0]


OK = json.dumps({"ok": True, "errors": 0, "warnings": 0, "findings": []})
