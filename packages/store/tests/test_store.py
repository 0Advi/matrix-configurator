import copy
import json

import psycopg
import pytest
from psycopg.types.json import Jsonb

from conftest import OK


def save(conn, ws, expected, manifest, actor="ana@example.com", via="ui"):
    return conn.execute("SELECT revision, manifest_sha256 FROM store_save_draft(%s, %s, %s, %s, NULL, NULL, %s)",
                        (ws, expected, Jsonb(manifest), actor, via)).fetchone()


def publish(conn, ws, revision, expected_live, reason="first release", validation=OK, rollback_of=None):
    return conn.execute("SELECT id, version, status FROM store_publish(%s, %s, %s, %s, %s::jsonb, 'ops@example.com', NULL, %s)",
                        (ws, revision, expected_live, reason, validation, rollback_of)).fetchone()


def code_of(exc):
    return str(exc.value).split(":", 1)[0]


# ── drafts ────────────────────────────────────────────────────────────────────────────────────────
def test_first_save_and_revision_conflict(conn, ws, manifest):
    assert save(conn, ws, None, manifest)[0] == 1
    m2 = copy.deepcopy(manifest); m2["workspace"]["name"] = "Acme Retail EU"
    assert save(conn, ws, 1, m2)[0] == 2
    with pytest.raises(psycopg.errors.RaiseException) as e:   # a second editor still on revision 1
        save(conn, ws, 1, manifest)
    assert code_of(e) == "revision_conflict"
    assert json.loads(e.value.diag.message_detail)["head_revision"] == 2


def test_noop_save_creates_no_revision(conn, ws, manifest):
    save(conn, ws, None, manifest)
    assert save(conn, ws, 1, manifest)[0] == 1
    n = conn.execute("SELECT count(*) FROM workspace_activity WHERE workspace_id=%s AND action='draft_saved'", (ws,)).fetchone()[0]
    assert n == 1


def test_drafts_are_append_only(conn, ws, manifest):
    save(conn, ws, None, manifest)
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE workspace_drafts SET note='x' WHERE workspace_id=%s", (ws,))
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("DELETE FROM workspace_drafts WHERE workspace_id=%s", (ws,))


# ── publish ───────────────────────────────────────────────────────────────────────────────────────
def test_publish_projects_modules_and_supersedes(conn, ws, manifest):
    save(conn, ws, None, manifest)
    rid, v, st = publish(conn, ws, 1, None)
    assert (v, st) == (1, "live")
    mods = conn.execute("SELECT module_key, position, enabled, members, stage_keys FROM workspace_modules WHERE workspace_id=%s ORDER BY position", (ws,)).fetchall()
    assert [m[0] for m in mods] == ["site_survey", "fit_out"]
    assert mods[1][3] == ["supervisor", "executive", "finance_reviewer"] and mods[0][4] == ["capture", "feasibility", "sign_off"]
    # v2: disable fit_out, drop nothing
    m2 = copy.deepcopy(manifest); m2["modules"][1]["enabled"] = False
    save(conn, ws, 1, m2)
    _, v2, _ = publish(conn, ws, 2, 1, reason="pause fit-out")
    assert v2 == 2
    rows = conn.execute("SELECT version, status FROM workspace_releases WHERE workspace_id=%s ORDER BY version", (ws,)).fetchall()
    assert rows == [(1, "superseded"), (2, "live")]
    assert conn.execute("SELECT enabled FROM workspace_modules WHERE workspace_id=%s AND module_key='fit_out'", (ws,)).fetchone()[0] is False
    acts = [a[0] for a in conn.execute("SELECT action FROM workspace_activity WHERE workspace_id=%s ORDER BY seq", (ws,))]
    assert acts == ["draft_saved", "release_published", "module_added", "module_added", "draft_saved", "release_published", "module_disabled"]


def test_publish_refuses_invalid_stale_and_identical(conn, ws, manifest):
    save(conn, ws, None, manifest)
    bad = json.dumps({"ok": False, "errors": 1, "findings": [{"code": "dead_gate"}]})
    with pytest.raises(psycopg.errors.RaiseException) as e:
        publish(conn, ws, 1, None, validation=bad)
    assert code_of(e) == "manifest_invalid"
    publish(conn, ws, 1, None)
    with pytest.raises(psycopg.errors.RaiseException) as e:   # publisher saw no live release, but v1 exists now
        publish(conn, ws, 1, None)
    assert code_of(e) == "live_changed"
    with pytest.raises(psycopg.errors.RaiseException) as e:
        publish(conn, ws, 1, 1)
    assert code_of(e) == "nothing_to_publish"
    m2 = copy.deepcopy(manifest); m2["workspace"]["name"] = "B"
    save(conn, ws, 1, m2); save(conn, ws, 2, manifest | {"workspace": {"key": "acme-retail", "name": "C"}})
    with pytest.raises(psycopg.errors.RaiseException) as e:   # publishing an older revision than the head
        publish(conn, ws, 2, 1)
    assert code_of(e) == "draft_changed"


def test_releases_are_immutable_and_single_live(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    for sql in ("UPDATE workspace_releases SET reason='edited' WHERE workspace_id=%s",
                "UPDATE workspace_releases SET manifest='{}' WHERE workspace_id=%s",
                "DELETE FROM workspace_releases WHERE workspace_id=%s"):
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute(sql, (ws,))
    with pytest.raises(psycopg.errors.UniqueViolation):   # a second live row is impossible even bypassing the function
        conn.execute("""INSERT INTO workspace_releases (workspace_id, version, format, manifest, manifest_sha256, validation, reason, published_by)
                        SELECT workspace_id, 99, format, manifest, manifest_sha256, validation, 'sneaky', 'x' FROM workspace_releases WHERE workspace_id=%s""", (ws,))


def test_rollback_is_a_new_version(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    m2 = copy.deepcopy(manifest); m2["modules"].pop(1)
    save(conn, ws, 1, m2); publish(conn, ws, 2, 1, reason="drop fit-out")
    assert conn.execute("SELECT in_live_release, enabled FROM workspace_modules WHERE workspace_id=%s AND module_key='fit_out'", (ws,)).fetchone() == (False, False)
    # roll back to v1: reset the draft to v1's manifest, publish it as v3
    v1 = conn.execute("SELECT manifest FROM workspace_releases WHERE workspace_id=%s AND version=1", (ws,)).fetchone()[0]
    save(conn, ws, 2, v1, via="reset")
    _, v3, _ = publish(conn, ws, 3, 2, reason="roll back to v1", rollback_of=1)
    assert v3 == 3
    assert conn.execute("SELECT in_live_release, enabled FROM workspace_modules WHERE workspace_id=%s AND module_key='fit_out'", (ws,)).fetchone() == (True, True)
    diff = conn.execute("SELECT module_key, change FROM store_release_diff(%s, 2, 3)", (ws,)).fetchall()
    assert diff == [("fit_out", "added"), ("site_survey", "unchanged")]
    acts = [a[0] for a in conn.execute("SELECT action FROM workspace_activity WHERE workspace_id=%s ORDER BY seq", (ws,))]
    assert "module_removed" in acts and "draft_reset" in acts and acts[-2:] == ["release_rolled_back", "module_added"]


def test_diff_changed(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    m2 = copy.deepcopy(manifest); m2["modules"][0]["stages"][0]["name"] = "Capture"
    save(conn, ws, 1, m2); publish(conn, ws, 2, 1, reason="rename")
    assert dict(conn.execute("SELECT module_key, change FROM store_release_diff(%s, 1, 2)", (ws,)).fetchall()) == {
        "site_survey": "changed", "fit_out": "unchanged"}
    assert conn.execute("SELECT changed_release_id <> introduced_release_id FROM workspace_modules WHERE workspace_id=%s AND module_key='site_survey'", (ws,)).fetchone()[0]


# ── activity ──────────────────────────────────────────────────────────────────────────────────────
def test_activity_hash_chain(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    rows = conn.execute("SELECT seq, prev_hash, hash FROM workspace_activity WHERE workspace_id=%s ORDER BY seq", (ws,)).fetchall()
    assert [r[0] for r in rows] == list(range(1, len(rows) + 1))
    assert rows[0][1] is None and all(rows[i][1] == rows[i - 1][2] for i in range(1, len(rows)))
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE workspace_activity SET actor='mallory' WHERE workspace_id=%s", (ws,))
    # forged seq/hash on insert are overwritten by the trigger
    conn.execute("INSERT INTO workspace_activity (workspace_id, seq, action, actor, hash) VALUES (%s, 1, 'draft_validated', 'x', %s)", (ws, "0" * 64))
    last = conn.execute("SELECT seq, prev_hash FROM workspace_activity WHERE workspace_id=%s ORDER BY seq DESC LIMIT 1", (ws,)).fetchone()
    assert last == (len(rows) + 1, rows[-1][2])


# ── migrations ────────────────────────────────────────────────────────────────────────────────────
def _plan_migration(conn, ws):
    rid = conn.execute("SELECT id FROM workspace_releases WHERE workspace_id=%s AND status='live'", (ws,)).fetchone()[0]
    return conn.execute("""INSERT INTO workspace_release_migrations (workspace_id, to_release_id, from_versions, plan, plan_sha256, reason, requested_by)
                           VALUES (%s, %s, '{1}', '{"cases": []}', %s, 'move to v2', 'ops') RETURNING id""", (ws, rid, "a" * 64)).fetchone()[0]


def test_migration_lifecycle_and_frozen_plan(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    m2 = copy.deepcopy(manifest); m2["workspace"]["name"] = "v2"
    save(conn, ws, 1, m2); publish(conn, ws, 2, 1, reason="ship v2")
    mid = _plan_migration(conn, ws)
    with pytest.raises(psycopg.errors.RaiseException):        # the reviewed plan cannot be edited
        conn.execute("UPDATE workspace_release_migrations SET plan='{\"cases\": [1]}' WHERE id=%s", (mid,))
    with pytest.raises(psycopg.errors.RaiseException):        # planned → done skips running
        conn.execute("UPDATE workspace_release_migrations SET status='done', started_at=now(), finished_at=now() WHERE id=%s", (mid,))
    conn.execute("UPDATE workspace_release_migrations SET status='running', started_at=now(), heartbeat_at=now() WHERE id=%s", (mid,))
    with pytest.raises(psycopg.errors.UniqueViolation):       # one running migration per workspace
        mid2 = _plan_migration(conn, ws)
        conn.execute("UPDATE workspace_release_migrations SET status='running', started_at=now() WHERE id=%s", (mid2,))
    conn.execute("UPDATE workspace_release_migrations SET status='done', finished_at=now(), summary='{\"moved\": 0}' WHERE id=%s", (mid,))
    with pytest.raises(psycopg.errors.RaiseException):        # done is final
        conn.execute("UPDATE workspace_release_migrations SET status='running' WHERE id=%s", (mid,))


def test_stale_migration_recovery(conn, ws, manifest):
    save(conn, ws, None, manifest); publish(conn, ws, 1, None)
    mid = _plan_migration(conn, ws)
    conn.execute("UPDATE workspace_release_migrations SET status='running', started_at=now() - interval '2 hours', heartbeat_at=now() - interval '2 hours' WHERE id=%s", (mid,))
    assert conn.execute("SELECT store_recover_stale_migrations()").fetchone()[0] >= 1
    st, err = conn.execute("SELECT status, error FROM workspace_release_migrations WHERE id=%s", (mid,)).fetchone()
    assert st == "failed" and err.startswith("recovered")
    assert conn.execute("SELECT count(*) FROM workspace_activity WHERE migration_id=%s AND action='migration_recovered'", (mid,)).fetchone()[0] == 1


# ── row-level security ────────────────────────────────────────────────────────────────────────────
def test_rls_isolates_workspaces(conn, app_conn, manifest):
    a = conn.execute("INSERT INTO workspaces (key, name) VALUES ('rls-a', 'A') RETURNING id").fetchone()[0]
    b = conn.execute("INSERT INTO workspaces (key, name) VALUES ('rls-b', 'B') RETURNING id").fetchone()[0]
    save(conn, a, None, manifest); save(conn, b, None, manifest)
    with app_conn.transaction():
        app_conn.execute("SELECT set_config('app.workspace_id', %s, true)", (str(a),))
        assert {r[0] for r in app_conn.execute("SELECT workspace_id FROM workspace_drafts")} == {a}
        assert app_conn.execute("SELECT revision FROM store_save_draft(%s, 1, %s, 'a-user')", (a, Jsonb(manifest | {"workspace": {"key": "acme-retail", "name": "A2"}}))).fetchone()[0] == 2
        # Workspace B is invisible: its head revision cannot even be read, so a save fails without leaking B's state …
        with pytest.raises(psycopg.errors.RaiseException) as e:
            app_conn.execute("SELECT store_save_draft(%s, 1, %s, 'a-user')", (b, Jsonb(manifest)))
        assert json.loads(e.value.diag.message_detail)["head_revision"] is None
    with app_conn.transaction():
        app_conn.execute("SELECT set_config('app.workspace_id', %s, true)", (str(a),))
        # … and any row written for B is refused by the policy's WITH CHECK.
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app_conn.execute("SELECT store_save_draft(%s, NULL, %s, 'a-user')", (b, Jsonb(manifest)))
    with app_conn.transaction():                                     # no workspace set → sees nothing
        assert app_conn.execute("SELECT count(*) FROM workspace_drafts").fetchone()[0] == 0
