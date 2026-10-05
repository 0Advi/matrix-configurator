"""Phase 2 (F4a) — configurator integration: data-driven modules, publish checks, platform
guard, custom-module runtime mapping.

Unit level (no DB), in the repo's RecordingSession style. The end-to-end proof against the
real database is app-stack/smoke-configurator.mjs (provision -> publish -> onboard -> run a
custom module -> publish v2 -> pinning -> audit provenance).
"""
from __future__ import annotations

import copy
import inspect
import json
import os
import uuid

import pytest
from fastapi import HTTPException

from app.services import module_registry_service as registry

_FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "configurator_workspace_manifest.json")

CATALOG = {
    "bd": {"config_key": "bd", "surface": "module", "retired": False},
    "legal": {"config_key": "legal", "surface": "module", "retired": False},
    "finance_ca": {"config_key": "finance_ca", "surface": "module", "retired": False},
    "design": {"config_key": "design", "surface": "module", "retired": False},
    "project_excellence": {"config_key": "pex", "surface": "module", "retired": False},
    "project": {"config_key": "project", "surface": "module", "retired": False},
    "nso": {"config_key": "nso", "surface": "module", "retired": False},
    "launch_approval": {"config_key": "launch_approval", "surface": "module", "retired": False},
    "financial_closure": {"config_key": "financial_closure", "surface": "module", "retired": False},
    "quality_audit": {"config_key": None, "surface": "scope", "retired": False},
    "payment": {"config_key": None, "surface": "module", "retired": True},
}


def _manifest() -> dict:
    with open(_FIXTURE, encoding="utf-8") as fh:
        return copy.deepcopy(json.load(fh)["manifest"])


def _vendor(m: dict) -> dict:
    return next(x for x in m["modules"] if x["key"] == "vendor_onboarding")


def _reg_row(key, *, kind="builtin", enabled=True, supervisor_only=False, has_membership=True,
             surface="module", label=None, position=10):
    row = {"module_key": key, "kind": kind, "catalog_key": key if kind == "builtin" else None,
           "config_key": key, "label": label or key.title(), "position": position, "enabled": enabled,
           "supervisor_only": supervisor_only, "delegation_enabled": True, "route": None,
           "introduced_release_id": None, "updated_release_id": None, "surface": surface,
           "implementation": f"builtin:{key}" if kind == "builtin" else None, "retired": False,
           "has_membership": has_membership}
    row["route"] = registry.module_route(row)
    return row


# ── M2: module keys + registry ────────────────────────────────────────────────

@pytest.mark.parametrize("key,ok", [
    ("bd", True), ("vendor_onboarding", True), ("project_excellence", True),
    ("Vendor", False), ("x", False), ("admin", False), ("9lives", False), ("a-b", False),
    ("vendor onboarding", False), ("", False), (None, False), ("a" * 40, False),
])
def test_module_key_rule_mirrors_the_sql_function(key, ok):
    assert registry.is_valid_module_key(key) is ok


def test_module_schema_accepts_custom_keys_and_rejects_junk():
    from pydantic import TypeAdapter, ValidationError

    from app.domain.schemas.business_admin import Module
    from app.domain.schemas.supervisor_codes import Module as SupModule

    assert SupModule is Module  # one definition
    ta = TypeAdapter(Module)
    assert ta.validate_python("vendor_onboarding") == "vendor_onboarding"
    with pytest.raises(ValidationError):
        ta.validate_python("Not A Key")


def test_routes_custom_to_generic_runtime_and_builtins_to_their_pages():
    assert registry.module_route(_reg_row("legal")) == "/legal"
    assert registry.module_route(_reg_row("vendor_onboarding", kind="custom")) == "/m/vendor_onboarding"
    assert registry.module_route(_reg_row("finance_ca")) is None
    # the manifest's built-in route (/bd, /pex, /finance-ca) is config data, not an SPA page
    assert registry.module_route({**_reg_row("bd"), "route": "/bd"}) == "/"
    assert registry.module_route({**_reg_row("project_excellence"), "route": "/pex"}) == "/project-excellence"


@pytest.mark.real_registry
async def test_require_membership_module_refuses_disabled_unknown_and_teamless(make_session, fake_result):
    tid = uuid.uuid4()
    # disabled -> 403
    sess = make_session(fake_result(mappings_rows=[_reg_row("design", enabled=False)]))
    with pytest.raises(HTTPException) as ei:
        await registry.require_membership_module(sess, tid, "design")
    assert ei.value.status_code == 403
    assert "tenant_modules" in sess.sql and "module_catalog" in sess.sql
    # not registered -> 404
    sess = make_session(fake_result(mappings_rows=[]))
    with pytest.raises(HTTPException) as ei:
        await registry.require_membership_module(sess, tid, "vendor_onboarding")
    assert ei.value.status_code == 404
    # registered but has no teams (finance_ca) -> 404
    sess = make_session(fake_result(mappings_rows=[_reg_row("finance_ca", has_membership=False)]))
    with pytest.raises(HTTPException) as ei:
        await registry.require_membership_module(sess, tid, "finance_ca")
    assert ei.value.status_code == 404
    # malformed key never reaches the DB
    sess = make_session()
    with pytest.raises(HTTPException):
        await registry.require_membership_module(sess, tid, "Bad Key")
    assert sess.executed == []
    # enabled custom module -> row
    sess = make_session(fake_result(mappings_rows=[_reg_row("vendor_onboarding", kind="custom")]))
    row = await registry.require_membership_module(sess, tid, "vendor_onboarding")
    assert row["kind"] == "custom" and row["route"] == "/m/vendor_onboarding"


async def test_org_view_is_driven_by_the_registry(make_session, fake_result, monkeypatch):
    """Custom department appears, a disabled built-in vanishes, supervisor-only comes from data."""
    from app.services import business_admin_service

    regs = [_reg_row("bd", position=10), _reg_row("design", enabled=False, position=30),
            _reg_row("vendor_onboarding", kind="custom", position=120, label="Vendor Onboarding"),
            _reg_row("site_audit", kind="custom", supervisor_only=True, position=130)]

    async def _list(session, tenant_id, *, enabled_only=True):
        return [r for r in regs if r["enabled"] or not enabled_only]
    monkeypatch.setattr(registry, "list_tenant_modules", _list)

    sup = uuid.uuid4()
    sess = make_session(
        fake_result(mappings_rows=[{"module": "vendor_onboarding", "code": "VEND-CODE"}]),
        fake_result(mappings_rows=[
            {"module": "vendor_onboarding", "role_in_module": "supervisor", "supervisor_id": None,
             "joined_at": None, "id": sup, "email": "s@x.co", "name": "Sup"},
            {"module": "design", "role_in_module": "supervisor", "supervisor_id": None,
             "joined_at": None, "id": uuid.uuid4(), "email": "d@x.co", "name": "Design Sup"},
            {"module": "site_audit", "role_in_module": "executive", "supervisor_id": sup,
             "joined_at": None, "id": uuid.uuid4(), "email": "e@x.co", "name": "Exec"},
        ]),
    )
    out = await business_admin_service.list_org(sess, uuid.uuid4())
    mods = {m["module"]: m for m in out["modules"]}
    assert list(mods) == ["bd", "vendor_onboarding", "site_audit"]          # by position, design hidden
    assert mods["vendor_onboarding"]["code"] == "VEND-CODE"
    assert mods["vendor_onboarding"]["label"] == "Vendor Onboarding" and mods["vendor_onboarding"]["kind"] == "custom"
    assert mods["site_audit"]["executives_enabled"] is False                 # supervisor-only from data
    assert mods["site_audit"]["unassigned_executives"] == []


async def test_supervisor_only_custom_module_refuses_executive_activation(make_session, monkeypatch):
    from app.services import supervisor_code_service

    async def _get(session, tenant_id, key):
        return _reg_row(key, kind="custom", supervisor_only=True, label="Site audit")
    monkeypatch.setattr(registry, "get_tenant_module", _get)
    sess = make_session()
    with pytest.raises(HTTPException) as ei:
        await supervisor_code_service.approve_my_pending_exec(
            sess, tenant_id="t", supervisor_id="s", user_id="u", module="site_audit")
    assert ei.value.status_code == 400 and "Site audit" in ei.value.detail
    assert "UPDATE users" not in sess.sql


async def test_disabled_module_mints_no_codes_and_admits_no_members(make_session, monkeypatch):
    from app.services import business_admin_service, supervisor_code_service

    async def _get(session, tenant_id, key):
        return _reg_row(key, enabled=False)
    monkeypatch.setattr(registry, "get_tenant_module", _get)
    for call in (
        lambda s: business_admin_service.rotate_dept_code(s, "t", "design", "u"),
        lambda s: business_admin_service.approve_supervisor(s, "t", "u", "design"),
        lambda s: supervisor_code_service.rotate_my_code(s, "t", "s", "design"),
        lambda s: supervisor_code_service.approve_my_pending_exec(s, "t", "s", "u", "design"),
    ):
        sess = make_session()
        with pytest.raises(HTTPException) as ei:
            await call(sess)
        assert ei.value.status_code == 403
        assert "INSERT" not in sess.sql and "UPDATE users" not in sess.sql


async def test_require_module_refuses_a_disabled_module_for_every_role():
    from app.rbac.guards import require_module

    guard = require_module("design")
    for role in ("business_admin", "observer", "supervisor"):
        with pytest.raises(HTTPException) as ei:
            await guard(current_user={"role": role, "module": "design", "disabled_modules": ["design"]})
        assert ei.value.status_code == 403
    ok = {"role": "supervisor", "module": "design", "disabled_modules": ["project_excellence"]}
    assert await guard(current_user=ok) is ok


def test_session_carries_the_disabled_module_list_without_an_extra_query():
    from app.core import deps
    src = inspect.getsource(deps.get_current_user)
    assert "disabled_modules" in src and "NOT tm.enabled" in src


def test_codes_and_claims_ignore_disabled_modules():
    from app.services import auth_repo
    for fn in (auth_repo.get_module_code, auth_repo.get_supervisor_invite_code, auth_repo.get_primary_membership):
        src = inspect.getsource(fn)
        assert "tenant_modules" in src and "enabled" in src, fn.__name__


def test_no_hardcoded_module_lists_remain_in_the_services():
    from app.services import business_admin_service, delegation_service, supervisor_code_service
    for mod, names in ((business_admin_service, ("_ORG_MODULES", "_SUPERVISOR_ONLY_MODULES", "_VALID_MODULES")),
                       (delegation_service, ("_VALID_MODULES",))):
        for n in names:
            assert not hasattr(mod, n), f"{mod.__name__}.{n} came back"
    assert 'if module == "nso":' not in inspect.getsource(supervisor_code_service)


# ── M3: publish checks ────────────────────────────────────────────────────────

def _check(m, **kw):
    from app.services.module_runtime.validate import check_manifest
    return check_manifest(m, catalog=CATALOG, **kw)


def _codes(report, severity="error"):
    return {f["code"] for f in report["findings"] if f["severity"] == severity}


def test_the_fixture_workspace_publishes_with_warnings_only():
    rep = _check(_manifest(), workspace_ref="ws_fixture")
    assert rep["ok"] and rep["errors"] == 0
    # pex waits on the disabled design; a text field marked affects_outcome cannot be scored
    assert {"gate_disabled_source", "rollup_field_ignored"} <= _codes(rep, "warning")
    resolved = {m["manifest_key"]: m for m in rep["modules"]}
    assert resolved["pex"]["key"] == "project_excellence" and resolved["pex"]["enabled"] is False
    assert resolved["vendor_onboarding"]["kind"] == "custom"


@pytest.mark.parametrize("mutate,code", [
    (lambda m: _vendor(m)["entry_gate"]["conditions"].append({"source": "nope", "outcome": "done"}),
     "gate_unknown_source"),
    (lambda m: _vendor(m).update(key="bd", route="/m/bd"), "duplicate_module"),
    (lambda m: m["modules"].append({**copy.deepcopy(_vendor(m)), "key": "pex", "route": "/m/pex"}),
     "duplicate_module"),
    (lambda m: m["modules"][0].update(key="payment_gateway"), "unknown_builtin"),
    (lambda m: _vendor(m)["stages"][0]["fields"].append(dict(_vendor(m)["stages"][0]["fields"][0])),
     "duplicate_field"),
    (lambda m: _vendor(m)["stages"][1].update(order=1), "duplicate_stage_order"),
    (lambda m: _vendor(m).update(stages=[]), "no_stages"),
    (lambda m: _vendor(m)["entry_gate"].update(match="most"), "schema"),
    (lambda m: _vendor(m).update(key="Vendor-Onboarding"), "schema"),
])
def test_publish_refuses_broken_manifests(mutate, code):
    m = _manifest()
    mutate(m)
    rep = _check(m)
    assert not rep["ok"]
    assert code in _codes(rep), rep["findings"]


def test_custom_module_cannot_take_a_builtin_alias():
    m = _manifest()
    m["modules"] = [x for x in m["modules"] if x["key"] != "pex"]
    v = copy.deepcopy(_vendor(m))
    v.update(key="pex", route="/m/pex")
    m["modules"].append(v)
    assert "custom_key_collides" in _codes(_check(m))


def test_unparsed_validation_hints_become_findings():
    m = _manifest()
    _vendor(m)["stages"][0]["fields"].append({"key": "notes", "label": "Notes", "kind": "number", "required": False,
                                             "validation": "two decimals please", "affects_outcome": False})
    rep = _check(m)
    assert rep["ok"]
    assert any(f["code"] == "unparsed_hint" and f.get("field") == "notes" for f in rep["findings"])


def test_gate_lint_runs_on_every_rule():
    from app.services.module_runtime import gates
    assert gates.lint({"==": [1, 1]})                      # soft equality is outside matrix-gate/1
    assert gates.lint(gates.compile_gate(_vendor(_manifest())["entry_gate"])) == []


# ── M3: platform guard ────────────────────────────────────────────────────────

def test_platform_routes_require_the_platform_admin_jwt():
    from app.core.security import issue_admin_token
    from app.routers.platform import platform_admin

    with pytest.raises(HTTPException) as ei:
        platform_admin(None)
    assert ei.value.status_code == 401
    with pytest.raises(HTTPException) as ei:
        platform_admin("not-a-jwt")
    assert ei.value.status_code == 401
    assert platform_admin(issue_admin_token(email="pa@example.com")) == {"email": "pa@example.com"}


def test_platform_and_runtime_routers_are_mounted():
    from app.main import ROUTERS
    from app.routers import module_runtime, platform, workspace
    assert {module_runtime, platform, workspace} <= set(ROUTERS)


# ── M4: runtime persistence mapping ───────────────────────────────────────────

def _rt(m=None):
    from app.services.module_runtime import runtime
    return runtime.ModuleRuntime(_vendor(m or _manifest()), release="rel-1")


def test_runtime_flow_and_stage_status_mapping():
    from app.services import module_runtime_service as svc
    from app.services.module_runtime import runtime

    rt = _rt()
    st, _ = rt.new_case("c1", "s1", {"reached": {"bd": ["submitted", "in progress"]}})
    assert st["status"] == "open"
    exe = runtime.Actor(id="e1", role="executive", delegated_sites=("s1",))
    sup = runtime.Actor(id="s1u", role="supervisor")
    st, ev = rt.act(st, exe, "submit", {"values": {"vendor_name": "A", "gst_number": "27ABCDE1234F1Z5"}})
    assert [svc._stage_status(st, s) for s in rt.stages] == ["submitted", "pending"]
    st, ev = rt.act(st, sup, "approve")
    assert [svc._stage_status(st, s) for s in rt.stages] == ["submitted", "in progress"]
    assert svc._policy(ev[0]) == "tier" and svc._policy({"type": "gate_opened"}) == "gate"


def test_gate_closed_without_the_builtin_outcome():
    from app.services import module_runtime_service as svc
    g = svc._gate_out(_rt(), {"reached": {"bd": ["submitted"]}, "stages": {}, "fields": {}})
    assert g["open"] is False and g["refusal"].startswith("Vendor onboarding is locked")
    assert g["conditions"][0]["met"] is False and g["conditions"][0]["reached"] == ["submitted"]


async def test_admin_override_is_recorded_as_submitted_with_the_flag(make_session):
    """F2 ruling: an admin form submission stays 'submitted'; the override flag is the event's."""
    from app.services import module_runtime_service as svc
    from app.services.module_runtime import runtime

    rt = _rt()
    st, _ = rt.new_case("c1", "s1", {"reached": {"bd": ["in progress"]}})
    ba = runtime.Actor(id=str(uuid.uuid4()), role="business_admin")
    st, events = rt.act(st, ba, "submit", {"values": {"vendor_name": "A", "gst_number": "27ABCDE1234F1Z5"}})
    assert events[0]["override"] is True
    sess = make_session()
    await svc._write_approvals(sess, tenant_id="t", record_id="r", release={"id": "rel-1"}, events=events)
    params = sess.execute_params[0]
    assert params["verdict"] == "submitted" and params["ovr"] is True
    assert params["tier"] == "executive" and params["arole"] == "business_admin"


async def test_admin_only_stage_submission_is_not_rewritten(make_session):
    from app.services import module_runtime_service as svc
    from app.services.module_runtime import runtime

    m = _manifest()
    v = _vendor(m)
    v["stages"] = [dict(v["stages"][1], order=1, approvers=["business_admin"], terminal=True)]
    rt = runtime.ModuleRuntime(v, release="rel-1")
    st, _ = rt.new_case("c1", "s1", {"reached": {"bd": ["in progress"]}})
    st, events = rt.act(st, runtime.Actor(id=str(uuid.uuid4()), role="business_admin"), "submit",
                        {"values": {"credit_days": 30}})
    sess = make_session()
    await svc._write_approvals(sess, tenant_id="t", record_id="r", release={"id": "rel-1"}, events=events)
    params = sess.execute_params[0]
    assert params["verdict"] == "submitted" and params["ovr"] is False and params["comment"] is None


def test_refusals_map_to_http_statuses():
    from app.services.module_runtime_service import _REFUSAL_STATUS
    assert _REFUSAL_STATUS["wrong_tier"] == 403 and _REFUSAL_STATUS["no_delegation"] == 403
    assert _REFUSAL_STATUS["gate_closed"] == 409 and _REFUSAL_STATUS["closed"] == 409
    assert _REFUSAL_STATUS["invalid_form"] == 422 and _REFUSAL_STATUS["reason_required"] == 422


def test_runtime_is_built_with_admin_override_on_and_from_the_pinned_release():
    from app.services import module_runtime_service as svc
    src = inspect.getsource(svc.runtime_for)
    assert "admin_override=False" not in src
    rel = {"id": "rel-9", "manifest": _manifest()}
    rt = svc.runtime_for(rel, svc.module_def(rel, "vendor_onboarding"))
    assert rt.release == "rel-9" and rt.admin_override is True
    assert svc.module_def(rel, "bd") is None          # built-ins never run on the generic runtime


def test_problem_detail_stays_a_string():
    from app.core.problems import ApiProblem
    p = ApiProblem(409, "locked", code="gate_closed", gate={"open": False})
    assert p.detail == "locked" and p.extra == {"code": "gate_closed", "gate": {"open": False}}
