"""F5a — caveat fixes (Phase 2c).

Fix 2: a built-in module switched OFF by the tenant's published configuration is
REFUSED by the API (403, every role), not only hidden in the UI. Before F5a only
the routes carrying require_module(...) refused it; BD (+ its /sites aliases,
staging, LOI), the finance_ca tab + admin queue, launch approvals, financial
closure and the business-admin tiers of design / project excellence stayed
reachable. Wiring is asserted from the mounted app itself (never re-listed by
hand for the routers), and the guard keys are checked against the catalog seed.

(Fixes 3–5 have their own sections further down.)
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from tests.conftest import LEGACY_REGISTRY

CATALOG_KEYS = {row[0] for row in LEGACY_REGISTRY}

# Router prefix → the module key every one of its routes must refuse when disabled.
ROUTER_MODULE = {
    "/bd": "bd",
    "/staging": "bd",
    "/loi": "bd",
    "/legal": "legal",
    "/design": "design",
    "/project-excellence": "project_excellence",
    "/project": "project",
    "/nso": "nso",
    "/launch-approvals": "launch_approval",
    "/financial-closure": "financial_closure",
}

# Single routes on shared routers.
ROUTE_MODULE = {
    ("POST", "/sites"): "bd",
    ("PATCH", "/sites/{site_id}/status"): "bd",
    ("PATCH", "/sites/{site_id}/details"): "bd",
    ("POST", "/sites/{site_id}/viewed"): "bd",
    ("POST", "/sites/{site_id}/archive"): "bd",
    ("POST", "/sites/{site_id}/revive"): "bd",
    ("POST", "/sites/{site_id}/reject"): "bd",
    ("POST", "/sites/{site_id}/assign"): "bd",
    ("POST", "/sites/{site_id}/photos"): "bd",
    ("POST", "/sites/{site_id}/loi"): "bd",
    ("PATCH", "/sites/{site_id}/finance"): "finance_ca",
    ("POST", "/sites/{site_id}/finance/request-approval"): "finance_ca",
    ("POST", "/sites/{site_id}/finance/approve"): "finance_ca",
    ("POST", "/sites/{site_id}/finance/reject"): "finance_ca",
    ("GET", "/business-admin/finance-approvals"): "finance_ca",
    ("POST", "/business-admin/finance-approvals/{site_id}/approve"): "finance_ca",
    ("POST", "/business-admin/finance-approvals/{site_id}/reject"): "finance_ca",
}


def _guard_keys(dependant) -> set[str]:
    keys: set[str] = set()
    for dep in dependant.dependencies:
        key = getattr(dep.call, "module_enabled_key", None)
        if key:
            keys.add(key)
        keys |= _guard_keys(dep)
    return keys


def _api_routes():
    from fastapi.routing import APIRoute

    from app.main import ROUTERS

    for r in ROUTERS:
        for route in r.router.routes:
            if isinstance(route, APIRoute):
                yield route


def _module_of_prefix(path: str):
    # longest prefix first so /project-excellence never matches /project
    for prefix in sorted(ROUTER_MODULE, key=len, reverse=True):
        if path == prefix or path.startswith(prefix + "/"):
            return ROUTER_MODULE[prefix]
    return None


def test_every_guarded_module_key_exists_in_the_catalog():
    import app.main  # noqa: F401 — mounts every router, which registers the guards
    from app.rbac.guards import GUARDED_MODULE_KEYS

    assert GUARDED_MODULE_KEYS, "no module guard registered"
    assert GUARDED_MODULE_KEYS <= CATALOG_KEYS, GUARDED_MODULE_KEYS - CATALOG_KEYS


def test_every_route_of_a_builtin_module_router_refuses_the_disabled_module():
    checked = 0
    missing = []
    for route in _api_routes():
        module = _module_of_prefix(route.path)
        if module is None:
            continue
        checked += 1
        if module not in _guard_keys(route.dependant):
            missing.append((sorted(route.methods), route.path, module))
    assert checked > 60, checked  # the ten routers really were walked
    assert missing == []


def test_bd_aliases_and_finance_routes_on_shared_routers_are_guarded():
    seen = {}
    for route in _api_routes():
        for method in route.methods:
            if (method, route.path) in ROUTE_MODULE:
                seen[(method, route.path)] = _guard_keys(route.dependant)
    assert set(seen) == set(ROUTE_MODULE), set(ROUTE_MODULE) - set(seen)
    wrong = {k: v for k, v in seen.items() if ROUTE_MODULE[k] not in v}
    assert wrong == {}


def test_shared_site_reads_stay_open_when_bd_is_off():
    """Sites are the spine every module (and custom-module cases) hang off: the reads
    stay available even in a workspace whose configuration switched BD off."""
    for route in _api_routes():
        if route.path in ("/sites", "/sites/{site_id}") and "GET" in route.methods:
            assert "bd" not in _guard_keys(route.dependant), route.path


@pytest.mark.parametrize("role", ["business_admin", "observer", "supervisor", "executive"])
async def test_disabled_module_is_refused_for_every_role(role):
    from app.rbac.guards import require_module_enabled

    guard = require_module_enabled("launch_approval")
    user = {"role": role, "real_role": role, "disabled_modules": ["launch_approval", "nso"]}
    with pytest.raises(HTTPException) as exc:
        await guard(current_user=user)
    assert exc.value.status_code == 403
    assert "disabled in this workspace" in exc.value.detail


async def test_enabled_module_passes_without_any_membership_check():
    """Existing tenants (every built-in enabled) behave exactly as before: the new
    guard adds no membership requirement (G2's D22 is a separate decision)."""
    from app.rbac.guards import require_module_enabled

    guard = require_module_enabled("bd")
    for user in (
        {"role": "executive", "module": "vendor_onboarding", "disabled_modules": []},
        {"role": "supervisor", "module": "legal", "disabled_modules": ["design"]},
        {"role": "business_admin", "disabled_modules": None},
    ):
        assert await guard(current_user=user) is user


# ── Fix 3: release-migration robustness ───────────────────────────────────────

async def test_recover_stale_marks_only_stale_running_headers_failed_and_audits(make_session, fake_result):
    import uuid as _uuid

    from app.services import release_migration_service as svc

    mid, tid, rid = _uuid.uuid4(), _uuid.uuid4(), _uuid.uuid4()
    sess = make_session(fake_result(mappings_rows=[
        {"id": mid, "tenant_id": tid, "to_release_id": rid, "summary": {"journal": {"sites": 1, "records": 2}}},
    ]))
    out = await svc.recover_stale_migrations(sess, tenant_id=tid)
    assert out == [{"id": str(mid), "tenant_id": str(tid)}]
    upd = sess.executed[0]
    assert "SET status = 'failed'" in upd and "WHERE m.status = 'running'" in upd
    assert "heartbeat_at" in upd and "make_interval" in upd       # stale = no heartbeat for N seconds
    assert "m.tenant_id = CAST(:tid AS uuid)" in upd
    assert sess.execute_params[0]["stale"] == svc.STALE_AFTER_SECONDS
    # never a site / record / journal write — header + audit only
    assert not any("UPDATE sites" in s or "UPDATE module_records" in s or "INSERT INTO module_release_migration_items" in s
                   for s in sess.executed)
    assert any("INSERT INTO audit_logs" in s for s in sess.executed)
    assert sess.execute_params[1]["action"] == "release_migration_recovered"
    assert sess.commit_count == 1


async def test_recover_stale_without_tenant_is_global_and_quiet_when_nothing_is_stale(make_session, fake_result):
    from app.services import release_migration_service as svc

    sess = make_session(fake_result(mappings_rows=[]))
    assert await svc.recover_stale_migrations(sess) == []
    assert ":tid" not in sess.executed[0]
    assert len(sess.executed) == 1  # no audit row


async def test_second_execute_is_refused_while_a_migration_is_live(make_session, fake_result):
    from app.core.problems import ApiProblem
    from app.services import release_migration_service as svc

    sess = make_session(fake_result(mappings_rows=[{"id": "11111111-1111-1111-1111-111111111111"}]))
    with pytest.raises(ApiProblem) as exc:
        await svc._refuse_if_live_migration(sess, "tenant-1")
    assert exc.value.status_code == 409
    assert "NOT (" in sess.executed[0]  # only a NON-stale running header blocks


async def test_an_unexpected_error_mid_run_marks_the_header_failed(monkeypatch, make_session, fake_result):
    """A crash inside the request (not a dead process) must not leave the header 'running'."""
    from app.services import release_migration_service as svc

    async def ws(_s, _ref):
        return {"tenant_id": "t-1", "live_release_id": "r2", "status": "active"}

    async def rels(_s, _tid):
        return {1: {"id": "r1", "version": 1, "manifest_sha256": "a"}, 2: {"id": "r2", "version": 2, "manifest_sha256": "b"}}

    async def nothing(*_a, **_k):
        return []

    async def plan_sites(*_a, **_k):
        return {"s-1": {"site_id": "s-1", "records": []}}, []

    async def boom(*_a, **_k):
        raise RuntimeError("connection lost")

    monkeypatch.setattr(svc, "_workspace", ws)
    monkeypatch.setattr(svc, "_releases", rels)
    monkeypatch.setattr(svc, "_candidates", nothing)
    monkeypatch.setattr(svc, "_plan_sites", plan_sites)
    monkeypatch.setattr(svc, "recover_stale_migrations", nothing)
    monkeypatch.setattr(svc, "_execute_all", boom)
    sess = make_session(fake_result(mappings_rows=[]))  # _refuse_if_live_migration: nothing live
    with pytest.raises(RuntimeError):
        await svc.svc_migrate_running_cases(
            sess, ref="ws_x", actor_email="pa@example.com", from_version=1, all_older=False, to_version=2,
            scope={}, reason="hot-fix", dry_run=False, options={})
    assert any("pg_advisory_xact_lock" in s for s in sess.executed)
    assert any("INSERT INTO module_release_migrations" in s for s in sess.executed)
    failed = [s for s in sess.executed if "SET status = 'failed'" in s]
    assert failed and "status = 'running'" in failed[0]


def test_include_idle_sites_is_an_optional_request_field_default_off():
    from app.routers.platform import MigrateIn

    assert MigrateIn().include_idle_sites is False
    assert MigrateIn(include_idle_sites=True).include_idle_sites is True


async def test_idle_sites_never_for_a_record_targeted_migration(make_session):
    from app.services import release_migration_service as svc

    sess = make_session()
    assert await svc._idle_sites(sess, "t-1", [1], {"record_ids": ["x"]}) == []
    assert sess.executed == []


# ── Fix 4: the generic runtime honours X-Override-Role (deps.py / G2 E3 semantics) ──────

REG = {"module_key": "vendor_onboarding", "label": "Vendor Onboarding", "kind": "custom", "enabled": True}


def _user(real, role=None, **kw):
    return {"sub": "u-1", "real_role": real, "role": role or real, "tenant_id": "t-1", **kw}


@pytest.mark.parametrize("user,rows,expected", [
    # business admin "simulating" an executive or a supervisor still ACTS as the business admin
    (_user("business_admin", "executive"), None, "business_admin"),
    (_user("business_admin", "supervisor"), None, "business_admin"),
    # an observer presenting as supervisor stays read-only
    (_user("observer", "supervisor"), None, "observer"),
    # dual-role supervisor (executive access in THIS module) dropped to executive
    (_user("supervisor", "executive"), [{"role_in_module": "supervisor", "exec_access": True}], "executive"),
    # ...without that access the override changes nothing
    (_user("supervisor", "executive"), [{"role_in_module": "supervisor", "exec_access": False}], "supervisor"),
    (_user("supervisor"), [{"role_in_module": "supervisor", "exec_access": True}], "supervisor"),
    # an executive cannot climb with the header
    (_user("executive", "supervisor"), [{"role_in_module": "executive", "exec_access": False}], "executive"),
])
async def test_actor_role_respects_real_role_for_acting(make_session, fake_result, user, rows, expected):
    from app.services.module_runtime_service import _actor_role

    sess = make_session(*([fake_result(mappings_rows=rows)] if rows is not None else []))
    assert await _actor_role(sess, user, "t-1", REG) == expected
    if rows is None:
        assert sess.executed == []  # workspace-wide roles never need a membership read


async def test_actor_role_non_member_is_refused(make_session, fake_result):
    from app.services.module_runtime_service import _actor_role

    with pytest.raises(HTTPException) as exc:
        await _actor_role(make_session(fake_result(mappings_rows=[])), _user("supervisor"), "t-1", REG)
    assert exc.value.status_code == 403


@pytest.mark.parametrize("user,actor_role,expected", [
    (_user("business_admin", "executive"), "business_admin", "executive"),
    (_user("business_admin", "supervisor"), "business_admin", "supervisor"),
    (_user("business_admin"), "business_admin", "business_admin"),
    (_user("observer", "executive"), "observer", "executive"),
    (_user("observer"), "observer", "observer"),
    (_user("supervisor", "executive"), "executive", "executive"),
    (_user("executive", "supervisor"), "executive", "executive"),  # members never widen scope
])
def test_view_role_follows_the_effective_role(user, actor_role, expected):
    from app.services.module_runtime_service import view_role

    assert view_role(user, actor_role) == expected


async def test_business_admin_simulating_an_executive_gets_executive_scope_but_acts_as_admin(
    monkeypatch, make_session, fake_result,
):
    from app.services import module_runtime_service as mrs

    async def reg(*_a, **_k):
        return REG

    async def none(*_a, **_k):
        return ()

    monkeypatch.setattr(mrs, "_custom_module", reg)
    monkeypatch.setattr(mrs, "_delegated_sites", none)
    monkeypatch.setattr(mrs, "_owned_sites", none)
    sess = make_session(fake_result(mappings_rows=[]))  # the records query
    out = await mrs.svc_list_records(sess, tenant_id="t-1", current_user=_user("business_admin", "executive"),
                                     module_key="vendor_onboarding")
    assert "r.opened_by = :uid" in sess.executed[-1]       # executive scope applied
    assert out["role"] == "business_admin" and out["view_role"] == "executive"

    sess = make_session(fake_result(mappings_rows=[]))
    out = await mrs.svc_list_records(sess, tenant_id="t-1", current_user=_user("business_admin"),
                                     module_key="vendor_onboarding")
    assert "r.opened_by = :uid" not in sess.executed[-1]   # no override: workspace-wide
    assert out["view_role"] == "business_admin"


# ── Fix 5: files for `kind: file` fields of custom modules ─────────────────────

FILE_STAGE = {"order": 1, "name": "Docs", "outcome": "submitted", "terminal": True,
              "approvers": ["executive", "supervisor"],
              "fields": [{"key": "vendor_name", "label": "Vendor", "kind": "text", "required": True},
                         {"key": "msme_cert", "label": "MSME certificate", "kind": "file", "required": False,
                          "validation": "PDF, max 2MB"}]}


class _FakeRt:
    """Just what the file helpers read from a ModuleRuntime."""

    def __init__(self, nxt, stages=(FILE_STAGE,)):
        self._nxt, self.stages = nxt, list(stages)

    def next_step(self, _state):
        return self._nxt


_SUBMIT = {"stage": 1, "kind": "submit", "role": "executive", "form": {"schema": {}, "uiSchema": {
    "msme_cert": {"ui:widget": "MatrixFileWidget", "ui:options": {"accept": ".pdf", "maxSize": "2MB"}}}}}


def test_the_form_compiler_gives_file_fields_the_upload_widget_and_limits():
    from app.services.module_runtime import forms

    out = forms.stage_form(FILE_STAGE, file_mode="ref")
    ui = out["uiSchema"]["msme_cert"]
    assert ui["ui:widget"] == "MatrixFileWidget"
    assert ui["ui:options"] == {"accept": ".pdf", "maxSize": "2MB"}
    assert out["schema"]["properties"]["msme_cert"]["type"] == "string"


def test_file_limit_follows_the_field_hint_capped_by_the_app_limit(monkeypatch):
    from app.services import module_runtime_service as mrs

    monkeypatch.setattr(mrs.settings, "max_upload_bytes", 25 * 1024 * 1024)
    assert mrs.file_limit_bytes({"maxSize": "2MB"}) == 2 * 1024 * 1024
    assert mrs.file_limit_bytes({"maxSize": "500KB"}) == 500 * 1024
    assert mrs.file_limit_bytes({"maxSize": "10GB"}) == 25 * 1024 * 1024   # never above the app cap
    assert mrs.file_limit_bytes({}) == 25 * 1024 * 1024


def test_file_type_must_match_the_fields_accept_list():
    from app.core.problems import ApiProblem
    from app.services.module_runtime_service import check_file_type

    check_file_type({"accept": ".pdf"}, "cert.PDF", "application/pdf")
    check_file_type({"accept": ".jpeg,.png"}, "photo.jpg", "image/jpeg")   # jpg == jpeg
    check_file_type({}, "anything.csv", "text/csv")                         # no hint: app allowlist only
    for name, ctype in (("cert.png", "image/png"), ("cert.pdf", "image/png"), ("cert", "application/pdf")):
        with pytest.raises(ApiProblem) as exc:
            check_file_type({"accept": ".pdf"}, name, ctype)
        assert exc.value.status_code == 415


def test_upload_is_only_for_a_file_field_of_the_current_form_step():
    from app.core.problems import ApiProblem
    from app.services.module_runtime_service import _file_field

    nxt, opts = _file_field(_FakeRt(_SUBMIT), {}, "msme_cert")
    assert nxt["stage"] == 1 and opts["accept"] == ".pdf"
    with pytest.raises(ApiProblem) as exc:
        _file_field(_FakeRt(_SUBMIT), {}, "vendor_name")      # not a file field
    assert exc.value.status_code == 422
    with pytest.raises(ApiProblem) as exc:
        _file_field(_FakeRt({**_SUBMIT, "kind": "approve"}), {}, "msme_cert")  # nothing to fill now
    assert exc.value.status_code == 409


async def test_submitted_file_values_must_be_files_of_this_record_stage_and_field(make_session, fake_result):
    from app.core.problems import ApiProblem
    from app.services.module_runtime_service import _check_file_values

    fid = "11111111-2222-3333-4444-555555555555"
    # typed reference (the F4b-era fallback) is refused without a query
    sess = make_session()
    with pytest.raises(ApiProblem) as exc:
        await _check_file_values(sess, tenant_id="t", record_id="r", rt=_FakeRt(_SUBMIT), state={},
                                 values={"vendor_name": "Acme", "msme_cert": "see email"})
    assert exc.value.status_code == 422 and exc.value.extra["errors"][0].startswith("msme_cert:")
    assert sess.executed == []
    # an id that is not a file of THIS record / stage / field (e.g. another tenant's) is refused
    sess = make_session(fake_result(all_rows=[]))
    with pytest.raises(ApiProblem):
        await _check_file_values(sess, tenant_id="t", record_id="r", rt=_FakeRt(_SUBMIT), state={},
                                 values={"msme_cert": fid})
    q = sess.executed[0]
    assert "tenant_id = :tid" in q and "record_id = :rid" in q and "stage_order = :stage" in q and "field_key = :field" in q
    # a real upload of this record passes; empty optional file fields are fine
    sess = make_session(fake_result(all_rows=[(1,)]))
    await _check_file_values(sess, tenant_id="t", record_id="r", rt=_FakeRt(_SUBMIT), state={},
                             values={"msme_cert": fid})
    await _check_file_values(make_session(), tenant_id="t", record_id="r", rt=_FakeRt(_SUBMIT), state={},
                             values={"vendor_name": "Acme", "msme_cert": ""})


def test_file_routes_are_mounted_member_guarded_and_observer_write_safe():
    from app.routers.module_runtime import router

    paths = {(m, r.path) for r in router.routes for m in r.methods}
    assert ("POST", "/m/{module_key}/records/{record_id}/files") in paths
    assert ("GET", "/m/{module_key}/files/{file_id}") in paths
    up = next(r for r in router.routes if r.path == "/m/{module_key}/records/{record_id}/files")
    names = set()

    def walk(d):
        for x in d.dependencies:
            names.add(getattr(x.call, "__name__", ""))
            walk(x)
    walk(up.dependant)
    assert "get_current_user" in names   # observers are refused writes there (deps._assert_may_write)


def test_module_files_migration_is_runner_safe_and_guarded():
    import pathlib

    from app.main import _parse_sql_statements

    sql = pathlib.Path(__file__).resolve().parents[1].joinpath(
        "database", "migrations", "20261006_1_module_files.sql").read_text()
    stmts = _parse_sql_statements(sql)
    assert len(stmts) == 12
    assert "CREATE TABLE IF NOT EXISTS public.module_files" in sql
    assert "cfg_forbid_mutation" in sql and "ENABLE ROW LEVEL SECURITY" in sql
    assert "REVOKE ALL ON public.module_files FROM anon" in sql
    assert "trg_module_files_guard" in sql


async def test_deleting_a_site_also_purges_its_custom_module_files(monkeypatch, make_session, fake_result):
    import uuid as _uuid

    from app.db import models
    from app.services import business_admin_service as svc
    from app.services import storage_service

    seen = []

    async def fake_delete(*, path):
        seen.append(path)
        return True

    monkeypatch.setattr(storage_service, "delete_object", fake_delete)
    tenant_id = _uuid.uuid4()
    site = models.Site(id=_uuid.uuid4(), tenant_id=tenant_id, name="S", city="Pune", status="draft_submitted")
    sess = make_session(
        fake_result(scalar=site),
        fake_result(scalars_list=["loi/t/s/loi.pdf"]),
        fake_result(scalars_list=[]),
        fake_result(scalars_list=["module-files/t/vendor/r/f/cert.pdf"]),
    )
    await svc.delete_site(sess, tenant_id, site.id, {"sub": str(_uuid.uuid4()), "name": "A", "role": "business_admin"})
    assert "FROM module_files WHERE site_id = :sid AND tenant_id = :tid" in sess.executed[3]
    assert seen == ["loi/t/s/loi.pdf", "module-files/t/vendor/r/f/cert.pdf"]


# ── Also fixed (F4a gap 8): crash-safe configurator provisioning ───────────────

async def test_resume_point_after_a_crash(make_session, fake_result):
    from app.services.platform_workspace_service import _resume_point

    assert await _resume_point(make_session(), None) == (None, None)
    tid = "22222222-2222-2222-2222-222222222222"
    approved = make_session(fake_result(mappings_rows=[{"status": "approved", "provisioned_tenant_id": tid}]))
    assert await _resume_point(approved, "req-1") == (None, tid)          # adopt, never a second tenant
    pending = make_session(fake_result(mappings_rows=[{"status": "pending", "provisioned_tenant_id": None}]))
    assert await _resume_point(pending, "req-1") == ("req-1", None)       # approve the SAME request
    rejected = make_session(fake_result(mappings_rows=[{"status": "rejected", "provisioned_tenant_id": None}]))
    assert await _resume_point(rejected, "req-1") == (None, None)         # start over


async def test_provision_retry_adopts_the_committed_tenant(monkeypatch, make_session):
    from app.services import platform_workspace_service as svc
    from app.services import tenancy_service

    calls = []

    async def claim(_s, _ref, _who):
        return "req-1"

    async def resume(_s, prior):
        return None, "tenant-1"

    async def adopt(_s, tenant_id):
        calls.append(("adopt", tenant_id))
        return {"tenant_id": tenant_id, "workspace_code": "ACME-1", "seat_limit": 10, "business_admin_id": "ba-1",
                "admin_email": "ba@acme.co", "admin_setup_token": "fresh-code", "company": "Acme", "recovered": True}

    async def never(*_a, **_k):
        raise AssertionError("must not create another request / tenant")

    monkeypatch.setattr(svc, "_claim_ref", claim)
    monkeypatch.setattr(svc, "_resume_point", resume)
    monkeypatch.setattr(svc, "_adopt_tenant", adopt)
    monkeypatch.setattr(tenancy_service, "insert_workspace_request", never)
    monkeypatch.setattr(tenancy_service, "approve_workspace_request", never)
    sess = make_session()
    out = await svc.svc_provision_workspace(
        sess, ref="ws_acme", company="Acme", admin_email="ba@acme.co", admin_name=None, seat_limit=None,
        team_size=None, city=None, source_ip=None, actor_email="pa@example.com")
    assert calls == [("adopt", "tenant-1")]
    assert out["recovered"] is True and out["tenant_id"] == "tenant-1" and out["admin_setup_token"] == "fresh-code"
    assert any("SET status = 'active'" in s for s in sess.executed)
    audit = [p for s, p in zip(sess.executed, sess.execute_params) if "INSERT INTO audit_logs" in s]
    assert audit and '"recovered": true' in audit[0]["prov"]
