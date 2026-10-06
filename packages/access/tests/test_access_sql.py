"""0003_access.sql against a real PostgreSQL (same DSN convention as packages/store). Skipped without a server."""
import json
import os
import uuid

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg.types.json import Jsonb  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PKGS = os.path.dirname(os.path.dirname(HERE))
DSN = os.environ.get("STORE_TEST_DSN", "postgresql://postgres@/postgres?host=/tmp&port=55432")
OK = json.dumps({"ok": True, "errors": 0, "warnings": 0, "findings": []})


@pytest.fixture(scope="module")
def conn():
    try:
        admin = psycopg.connect(DSN, autocommit=True)
    except psycopg.OperationalError:
        pytest.skip("no PostgreSQL at STORE_TEST_DSN")
    name = "access_test_" + uuid.uuid4().hex[:8]
    admin.execute(f'CREATE DATABASE "{name}"')
    c = psycopg.connect(DSN.replace("/postgres?", f"/{name}?"), autocommit=True)
    c.execute("CREATE TABLE workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, name text NOT NULL)")
    c.execute(open(os.path.join(PKGS, "store", "sql", "0002_store.sql"), encoding="utf-8").read())
    for _ in range(2):                                                        # idempotent
        c.execute(open(os.path.join(PKGS, "access", "sql", "0003_access.sql"), encoding="utf-8").read())
    yield c
    c.close()
    admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    admin.close()


@pytest.fixture(scope="module")
def ws(conn):
    manifest = json.load(open(os.path.join(PKGS, "manifest", "examples", "acme-retail.manifest.json"), encoding="utf-8"))
    w = conn.execute("INSERT INTO workspaces (key, name) VALUES ('acme', 'Acme') RETURNING id").fetchone()[0]
    rev = conn.execute("SELECT revision FROM store_save_draft(%s, NULL, %s, 'wil', NULL, NULL, 'ui')", (w, Jsonb(manifest))).fetchone()[0]
    conn.execute("SELECT 1 FROM store_publish(%s, %s, NULL, 'first release', %s::jsonb, 'wil', NULL, NULL)", (w, rev, OK))
    return w


def err(conn, sql, args):
    with pytest.raises(psycopg.errors.RaiseException) as e:
        conn.execute(sql, args)
    return str(e.value).split(":", 1)[0]


def test_many_memberships_and_principal(conn, ws):
    u = uuid.uuid4()
    conn.execute("INSERT INTO module_memberships (workspace_id, user_id, module_key, role_key) VALUES "
                 "(%s,%s,'site_survey','executive'), (%s,%s,'fit_out','executive'), (%s,%s,'fit_out','finance_reviewer')",
                 (ws, u, ws, u, ws, u))
    conn.execute("INSERT INTO workspace_role_assignments (workspace_id, user_id, role_key) VALUES (%s,%s,'observer')", (ws, u))
    roles, mems, ver = conn.execute("SELECT * FROM access_principal(%s,%s)", (ws, u)).fetchone()
    assert roles == ["observer"] and ver == 4
    assert mems == [["fit_out", "executive"], ["fit_out", "finance_reviewer"], ["site_survey", "executive"]]
    conn.execute("DELETE FROM module_memberships WHERE user_id = %s AND role_key = 'finance_reviewer'", (u,))
    assert conn.execute("SELECT access_version FROM access_principal(%s,%s)", (ws, u)).fetchone()[0] == 5
    acts = conn.execute("SELECT action FROM workspace_activity WHERE workspace_id=%s AND action LIKE 'access_%%' ORDER BY seq", (ws,)).fetchall()
    assert [a for (a,) in acts][-2:] == ["access_granted", "access_revoked"]


def test_roles_checked_against_live_release(conn, ws):
    u = uuid.uuid4()
    ins_m = "INSERT INTO module_memberships (workspace_id, user_id, module_key, role_key) VALUES (%s,%s,%s,%s)"
    ins_w = "INSERT INTO workspace_role_assignments (workspace_id, user_id, role_key) VALUES (%s,%s,%s)"
    assert err(conn, ins_m, (ws, u, "site_survey", "auditor")) == "unknown_role"
    assert err(conn, ins_m, (ws, u, "site_survey", "business_admin")) == "role_scope"
    assert err(conn, ins_w, (ws, u, "supervisor")) == "role_scope"
    assert err(conn, ins_m, (ws, u, "site_survey", "finance_reviewer")) == "not_a_member_role"
