"""Phase 2b (G3) — migrate running cases (#2), creator-scoped stages (#3), role-scoped saved views (#4).

Unit level (no DB), in the style of test_configurator_integration.py. The end-to-end proof against
the real database (journal-bound re-pin guard, approvals guard, seeded views, scoped lists) is
app-stack/smoke-g3.mjs.
"""
from __future__ import annotations

import copy
import os
import re

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.services.module_runtime import migrate, runtime

_MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "database", "migrations")
G3_FILES = ("20261005_1_release_migrations.sql", "20261005_2_creator_scoped_stages.sql",
            "20261005_3_module_views.sql")


def _module(*, v2=False, creator=True, stage1_chain=("executive", "supervisor")):
    stages = [
        {"order": 1, "name": "Vendor capture", "outcome": "submitted", "terminal": False,
         "approvers": list(stage1_chain),
         "fields": [{"key": "vendor_name", "label": "Vendor", "kind": "text", "required": True,
                     "validation": None, "affects_outcome": False}]},
        {"order": 2, "name": "Compliance check", "outcome": "approved", "terminal": v2, "approvers": ["supervisor"],
         "fields": [{"key": "credit_days", "label": "Credit days", "kind": "number", "required": True,
                     "validation": None, "affects_outcome": False}]},
    ]
    if creator:
        stages[0]["restricted_to"] = "site_creator"
    if v2:
        stages[1]["fields"].append({"key": "payment_terms", "label": "Terms", "kind": "text", "required": True,
                                    "validation": None, "affects_outcome": False})
    else:
        stages.append({"order": 3, "name": "Sign-off", "outcome": "approved", "terminal": True,
                       "approvers": ["supervisor", "business_admin"], "fields": []})
    return {"key": "g3_vendor", "name": "G3 Vendor", "type": "custom", "enabled": True, "route": "/m/g3_vendor",
            "state": "live", "navigation": [],
            "tiers": {"supervisor": True, "executive": True, "business_admin_signoff": True, "delegation": True},
            "entry_gate": None, "stages": stages, "rollup": {"strategy": "all_positive"}, "exit_signal": "approved"}


OWNER = runtime.Actor(id="ex1", role="executive", owned_sites=("site1",))
DELEGATE = runtime.Actor(id="ex2", role="executive", delegated_sites=("site1",))
SUP = runtime.Actor(id="sup", role="supervisor")
SUP_OWNER = runtime.Actor(id="sup2", role="supervisor", owned_sites=("site1",))
BA = runtime.Actor(id="ba", role="business_admin")


def _case(m=None, release="rel-1"):
    rt = runtime.ModuleRuntime(m or _module(), release=release)
    st, ev = rt.new_case("case1", "site1", {})
    return rt, st, ev


# ── #3 creator-scoped stages: runtime ─────────────────────────────────────────

def test_creator_step_is_announced_and_only_the_owner_may_act():
    rt, st, _ = _case()
    assert rt.next_step(st)["restricted_to"] == "site_creator"
    assert rt.actions(st, OWNER) == ["submit"]          # owner: no delegation needed for the creator step
    assert rt.actions(st, DELEGATE) == []               # delegated, but not the creator
    assert rt.actions(st, SUP) == []                    # supervisor in the chain, but not the creator
    assert rt.actions(st, SUP_OWNER) == ["submit"]      # a supervisor who created the site (real app E1)
    for who in (DELEGATE, SUP):
        with pytest.raises(runtime.Refusal) as ei:
            rt.act(st, who, "submit", {"values": {"vendor_name": "x"}})
        assert ei.value.code == "not_site_creator"


def test_owner_submission_is_not_an_override_and_carries_the_rule():
    rt, st, _ = _case()
    st2, ev = rt.act(st, OWNER, "submit", {"values": {"vendor_name": "Acme"}})
    assert ev[0]["override"] is False
    assert ev[0]["payload"]["restricted_to"] == "site_creator" and ev[0]["payload"]["site_creator"] is True
    assert ev[0]["payload"]["acting_as_delegate"] is False
    assert "restricted_to" not in (rt.next_step(st2) or {})   # the supervisor step is not creator-scoped
    assert rt.actions(st2, SUP) == ["approve", "send_back", "reject"]


def test_business_admin_non_owner_acts_only_as_flagged_override():
    rt, st, _ = _case()
    _, ev = rt.act(st, BA, "submit", {"values": {"vendor_name": "Acme"}})
    assert ev[0]["override"] is True and ev[0]["payload"]["site_creator"] is False


def test_business_admin_in_the_chain_still_overrides_when_not_the_creator():
    m = _module(stage1_chain=("executive", "business_admin"))
    rt, st, _ = _case(m)
    st2, ev = rt.act(st, BA, "submit", {"values": {"vendor_name": "Acme"}})
    assert ev[0]["override"] is True and len(ev) == 1      # an override never self-approves (no collapse)
    with pytest.raises(runtime.Refusal) as ei:               # separation of duties: a second BA must sign
        rt.act(st2, BA, "approve")
    assert ei.value.code == "separation_of_duties"
    owner_ba = runtime.Actor(id="ba", role="business_admin", owned_sites=("site1",))
    _, ev = rt.act(st, owner_ba, "submit", {"values": {"vendor_name": "Acme"}})
    assert ev[0]["override"] is False                        # the creator BA is entitled (in the chain)


def test_without_the_rule_behaviour_is_unchanged():
    rt, st, _ = _case(_module(creator=False))
    assert "restricted_to" not in rt.next_step(st)
    assert rt.actions(st, DELEGATE) == ["submit"]
    with pytest.raises(runtime.Refusal) as ei:
        rt.act(st, OWNER, "submit", {"values": {"vendor_name": "x"}})   # owner but no delegation
    assert ei.value.code == "no_delegation"


def test_not_site_creator_maps_to_403_and_provenance_marks_creator_overrides():
    from app.services import module_runtime_service as svc
    assert svc._REFUSAL_STATUS["not_site_creator"] == 403
    assert svc.has_creator_rule(_module()) and not svc.has_creator_rule(_module(creator=False))


async def test_creator_override_is_written_to_the_audit_provenance(make_session):
    import json

    from app.services import module_runtime_service as svc
    rt, st, _ = _case()
    _, events = rt.act(st, BA, "submit", {"values": {"vendor_name": "Acme"}})
    sess = make_session()
    await svc._write_events(sess, tenant_id="t", site_id="site1", record_id="r",
                            release={"id": "rel-1", "version": 1, "manifest_sha256": "x"}, module_key="g3_vendor",
                            events=events, current_user={"sub": "ba", "name": "BA"})
    prov = json.loads(sess.execute_params[0]["prov"])
    assert prov["rule"] == "site_creator" and prov["site_creator"] is False
    assert prov["override"] is True and prov["creator_override"] is True


def test_executive_scope_includes_owned_sites_only_for_creator_scoped_modules():
    from app.services import module_runtime_service as svc
    row = {"opened_by": "sup", "assigned_to": None, "site_id": "site1"}
    assert svc._executive_sees(OWNER, row, _module()) is True
    assert svc._executive_sees(OWNER, row, _module(creator=False)) is False
    assert svc._executive_sees(DELEGATE, row, _module(creator=False)) is True
    assert svc._executive_sees(runtime.Actor(id="x", role="executive"), row, _module()) is False


# ── #3 publish validation ─────────────────────────────────────────────────────

def _manifest_with(module):
    from tests.test_configurator_integration import _manifest
    m = _manifest()
    m["modules"] = [x for x in m["modules"] if x.get("key") != module["key"]] + [module]
    return m


def test_publish_accepts_the_rule_and_warns_when_the_first_tier_is_not_executive():
    from app.services.module_runtime.validate import check_manifest
    from tests.test_configurator_integration import CATALOG

    rep = check_manifest(_manifest_with(_module()), catalog=CATALOG)
    assert rep["ok"] and not [f for f in rep["findings"] if f["code"].startswith("creator_rule")]
    m = _module()
    m["stages"][1]["restricted_to"] = "site_creator"
    rep = check_manifest(_manifest_with(m), catalog=CATALOG)
    assert rep["ok"] and [f["stage"] for f in rep["findings"] if f["code"] == "creator_rule_first_tier"] == [2]
    m["stages"][1]["restricted_to"] = "initiator"
    rep = check_manifest(_manifest_with(m), catalog=CATALOG)
    assert not rep["ok"] and any(f["code"] == "schema" and f["path"].endswith("restricted_to")
                                 for f in rep["findings"])


def test_publish_warns_that_builtins_ignore_the_rule():
    from app.services.module_runtime.validate import check_manifest
    from tests.test_configurator_integration import CATALOG, _manifest
    m = _manifest()
    bd = next(x for x in m["modules"] if x["key"] == "bd")
    bd["stages"][0]["restricted_to"] = "site_creator"
    rep = check_manifest(m, catalog=CATALOG)
    assert rep["ok"] and any(f["code"] == "creator_rule_builtin_ignored" and f["module"] == "bd"
                             for f in rep["findings"])


# ── #2 migrate running cases: planner ─────────────────────────────────────────

def _rts(src_m=None, dst_m=None):
    return (runtime.ModuleRuntime(src_m or _module(), release="rel-1"),
            runtime.ModuleRuntime(dst_m or _module(v2=True), release="rel-2"))


def _at_stage2():
    rt, st, ev = _case()
    st, e1 = rt.act(st, OWNER, "submit", {"values": {"vendor_name": "Acme"}})
    st, e2 = rt.act(st, SUP, "approve")
    return rt, st, ev + e1 + e2


def test_stage_mapping_rules():
    src = runtime.ModuleRuntime(_module(), release="a")
    dst_m = _module(v2=True)
    dst_m["stages"] = [dict(dst_m["stages"][1], order=1, terminal=False),          # Compliance moved to 1
                       dict(dst_m["stages"][0], order=2, name="Vendor capture (fixed)", terminal=True)]
    dst = runtime.ModuleRuntime(dst_m, release="b")
    mp = migrate.stage_mapping(src, dst)
    assert mp[1] == (1, "by_order")       # renamed in place: "Vendor capture" has no namesake in the target
    assert mp[2] == (1, "by_name")        # "Compliance check" moved to order 1
    assert mp[3] == (None, "unmapped")
    assert migrate.stage_mapping(src, dst, {"1": 2})[1] == (2, "explicit")
    same = migrate.stage_mapping(src, runtime.ModuleRuntime(_module(), release="c"))
    assert all(how == "same" for _, how in same.values())


def test_compatible_case_moves_with_values_approvals_and_a_chained_event():
    src, dst = _rts()
    rt, st, events = _at_stage2()
    p = migrate.plan(st, src, dst, target_version=2)
    assert p["compatible"] and p["before"]["order"] == 2 and p["after"]["order"] == 2
    assert {"stage": 1, "field": "vendor_name"} in p["fields"]["kept"] and not p["fields"]["dropped"]
    assert next(m for m in p["stage_mapping"] if m["from"]["order"] == 3)["to"] is None
    new, ev = migrate.apply(st, dst, p, actor=runtime.Actor(id="pa@example.com", role="platform_admin"),
                            payload={"reason": "hot-fix"})
    assert new["release"] == "rel-2" and new["stage"] == 2 and new["completed"] == [1]
    assert new["values"] == {"1": {"vendor_name": "Acme"}} and new["seq"] == st["seq"] + 1
    assert ev["type"] == "release_migrated" and ev["prev"] == st["last_hash"] and ev["release"] == "rel-2"
    assert runtime.verify_chain(events + [ev])
    assert st["release"] == "rel-1"                       # pure: the input state is untouched
    nxt = dst.next_step(new)                              # the case continues under the target's rules
    assert nxt["role"] == "supervisor" and "payment_terms" in nxt["form"]["schema"]["properties"]


def test_case_on_a_removed_stage_is_blocked():
    src, dst = _rts()
    rt, st, _ = _at_stage2()
    st, _ = rt.act(st, SUP, "submit", {"values": {"credit_days": 10}})
    assert st["stage"] == 3
    p = migrate.plan(st, src, dst, target_version=2)
    assert not p["compatible"] and [b["code"] for b in p["blocking"]] == ["stage_missing"]
    with pytest.raises(ValueError):
        migrate.apply(st, dst, p, actor=runtime.Actor(id="pa", role="platform_admin"), payload={})


def test_finished_and_missing_or_disabled_modules_are_not_migrated():
    src, dst = _rts()
    _, st, _ = _at_stage2()
    done = dict(st, status="completed")
    assert migrate.plan(done, src, dst)["blocking"][0]["code"] == "not_in_flight"
    assert migrate.plan(st, src, None)["blocking"][0]["code"] == "module_not_in_target"
    assert migrate.plan(st, src, dst, target_enabled=False)["blocking"][0]["code"] == "module_disabled_in_target"


def test_mid_stage_chain_change_blocks_unless_the_stage_restarts():
    src = runtime.ModuleRuntime(_module(), release="rel-1")
    dst_m = _module(v2=True)
    dst_m["stages"][0]["approvers"] = ["supervisor"]           # the executive step is gone
    dst = runtime.ModuleRuntime(dst_m, release="rel-2")
    rt, st, _ = _case()
    st, _ = rt.act(st, OWNER, "submit", {"values": {"vendor_name": "Acme"}})   # step 1 of stage 1
    p = migrate.plan(st, src, dst)
    assert not p["compatible"] and p["blocking"][0]["code"] == "chain_changed_mid_stage"
    p = migrate.plan(st, src, dst, restart_stage_on_chain_change=True)
    assert p["compatible"] and p["new_core"]["step"] == 0 and p["new_core"]["pass"] == []
    assert any(w["code"] == "stage_restarted" for w in p["warnings"])
    assert p["new_core"]["values"] == {"1": {"vendor_name": "Acme"}}           # values kept


def test_dropped_fields_new_required_fields_and_skipped_new_stages_are_reported():
    src = runtime.ModuleRuntime(_module(), release="rel-1")
    dst_m = _module(v2=True)
    dst_m["stages"][0]["fields"] = [{"key": "supplier", "label": "Supplier", "kind": "text", "required": True}]
    dst_m["stages"].insert(1, {"order": 2, "name": "KYC", "outcome": "submitted", "terminal": False,
                               "approvers": ["supervisor"], "fields": []})
    dst_m["stages"][2]["order"] = 3
    dst = runtime.ModuleRuntime(dst_m, release="rel-2")
    _, st, _ = _at_stage2()
    p = migrate.plan(st, src, dst, target_version=2)
    assert p["compatible"] and p["after"]["order"] == 3                          # mapped by name
    codes = {w["code"] for w in p["warnings"]}
    assert {"fields_dropped", "new_required_field", "skips_new_stage"} <= codes
    assert p["fields"]["dropped"] == [{"stage": 1, "field": "vendor_name"}]
    assert {"stage": 1, "field": "supplier"} in p["fields"]["new_required"]


def test_explicit_mapping_must_keep_stage_order():
    src, dst = _rts()
    _, st, _ = _at_stage2()
    p = migrate.plan(st, src, dst, stage_map={"1": 2, "2": 1})
    assert not p["compatible"] and {"mapping_not_monotonic"} <= {b["code"] for b in p["blocking"]}


def test_target_and_source_resolution():
    from app.services import release_migration_service as svc
    rels = {1: {"id": "a", "version": 1}, 2: {"id": "b", "version": 2}, 3: {"id": "c", "version": 3}}
    ws = {"live_release_id": "c"}
    tgt, src, spec = svc._target_and_sources(rels, ws, from_version=None, all_older=True, to_version=None)
    assert tgt["version"] == 3 and src == [1, 2] and spec == "all_older"
    tgt, src, spec = svc._target_and_sources(rels, ws, from_version=1, all_older=False, to_version=2)
    assert (tgt["version"], src, spec) == (2, [1], "v1")
    for kw, code in ((dict(from_version=2, to_version=2), "same_release"),
                     (dict(from_version=9, to_version=2), "unknown_release"),
                     (dict(from_version=1, to_version=9), "unknown_release")):
        with pytest.raises(HTTPException) as ei:
            svc._target_and_sources(rels, ws, all_older=False, **kw)
        assert ei.value.extra["code"] == code


async def test_execute_requires_a_reason(make_session):
    from app.services import release_migration_service as svc
    with pytest.raises(HTTPException) as ei:
        await svc.svc_migrate_running_cases(make_session(), ref="x", actor_email="pa@example.com", from_version=1,
                                            all_older=False, to_version=2, scope={}, reason="  ",
                                            dry_run=False, options={})
    assert ei.value.status_code == 422 and ei.value.extra["code"] == "reason_required"


def test_migration_request_model():
    from app.routers.platform import MigrateIn
    assert MigrateIn().from_release_version == "all_older" and MigrateIn().dry_run is True
    assert MigrateIn(from_release_version=3).from_release_version == 3
    with pytest.raises(ValidationError):
        MigrateIn(scope={"tenant_id": "x"})                       # unknown scope keys refused
    with pytest.raises(ValidationError):
        MigrateIn(scope={"site_ids": ["not-a-uuid"]})
    with pytest.raises(ValidationError):
        MigrateIn(from_release_version="latest")


# ── #4 saved views ────────────────────────────────────────────────────────────

def _item(**kw):
    base = {"site": {"id": "11111111-2222-3333-4444-555555555555"}, "case_status": "in_progress", "current_stage": 2,
            "next_step": {"role": "supervisor", "kind": "submit"}, "allowed_actions": ["submit"],
            "assigned_to": None, "_opened_by": "sup", "_site_submitted_by": "ex1", "_site_assigned_to": None}
    base.update(kw)
    return base


def test_view_filter_refuses_unknown_keys_and_bad_values():
    from app.domain.schemas.module_views import ViewFilter, ViewIn
    for bad in ({"tenant_id": "t"}, {"role": "business_admin"}, {"awaiting": "anyone"}, {"status": ["open", "x"]},
                {"site_ids": ["nope"]}, {"opened_by": "u"}):
        with pytest.raises(ValidationError):
            ViewFilter.model_validate(bad)
    with pytest.raises(ValidationError):
        ViewIn(name="x", audience=["platform_admin"])
    with pytest.raises(ValidationError):
        ViewIn(name="x", columns=["password"])
    assert ViewIn(name="  My view ").name == "My view"


def test_view_filter_semantics():
    from app.services.module_views_service import matches
    it = _item()
    assert matches(it, {}, me="x", role="supervisor")
    assert matches(it, {"awaiting": "my_tier", "actionable": True}, me="sup", role="supervisor")
    assert not matches(it, {"awaiting": "my_tier"}, me="ex1", role="executive")
    assert matches(it, {"awaiting": "supervisor"}, me="ex1", role="executive")
    assert matches(it, {"created_by_me": True}, me="ex1", role="executive")       # created the site
    assert matches(it, {"created_by_me": True}, me="sup", role="supervisor")      # opened the case
    assert matches(it, {"mine": True}, me="ex9", role="executive", delegated=("11111111-2222-3333-4444-555555555555",))
    assert not matches(it, {"mine": True}, me="ex9", role="executive")
    assert matches(_item(_site_assigned_to="ex7"), {"assigned_to_me": True}, me="ex7", role="executive")
    assert matches(it, {"assigned": False, "closed": False, "stage": [2], "status": ["in_progress"]},
                   me="x", role="supervisor")
    assert not matches(_item(case_status="parked"), {"closed": False}, me="x", role="supervisor")
    assert matches(it, {"site_ids": ["11111111-2222-3333-4444-555555555555"], "kind": "submit"}, me="x", role="supervisor")
    assert not matches(it, {"site_ids": ["00000000-0000-0000-0000-000000000000"]}, me="x", role="supervisor")


def test_default_view_resolution_per_role():
    from app.services.module_views_service import default_view_id
    views = [{"id": "a", "audience": ["executive", "supervisor"], "is_default": True},
             {"id": "b", "audience": ["business_admin"], "is_default": True},
             {"id": "c", "audience": ["executive", "supervisor", "business_admin", "observer"], "is_default": True},
             {"id": "d", "audience": ["observer"], "is_default": False}]
    assert [default_view_id(views, r) for r in ("executive", "business_admin", "observer")] == ["a", "b", "c"]
    assert default_view_id([{"id": "z", "audience": ["observer"], "is_default": False}], "observer") == "z"
    assert default_view_id(views[:1], "observer") is None


async def test_view_outside_the_audience_is_404(make_session):
    from tests.conftest import FakeResult
    from app.services import module_views_service as svc
    row = {"id": "v", "module_key": "g3_vendor", "name": "Admin", "filter": {}, "columns": [],
           "audience": ["business_admin"], "position": 1, "is_default": True, "seed_key": "admin_signoff",
           "created_by": None, "created_at": None, "updated_at": None}
    sess = make_session(FakeResult(mappings_rows=[row]))
    with pytest.raises(HTTPException) as ei:
        await svc.get_view_for(sess, "t", "g3_vendor", "v", "executive")
    assert ei.value.status_code == 404
    assert "tenant_id = :tid" in sess.executed[0] and "deleted_at IS NULL" in sess.executed[0]


def test_views_and_migration_routes_are_mounted():
    from app.main import ROUTERS, app
    from app.routers import module_views
    assert module_views in ROUTERS
    paths = {(m, r.path) for r in app.routes for m in getattr(r, "methods", ())}
    for want in (("GET", "/api/m/{module_key}/views"), ("POST", "/api/m/{module_key}/views"),
                 ("PATCH", "/api/m/{module_key}/views/{view_id}"), ("DELETE", "/api/m/{module_key}/views/{view_id}"),
                 ("POST", "/api/m/{module_key}/views/reset"),
                 ("POST", "/api/platform/workspaces/{ref}/migrations"),
                 ("GET", "/api/platform/workspaces/{ref}/migrations"),
                 ("GET", "/api/platform/workspaces/{ref}/migrations/{migration_id}")):
        assert want in paths, want


# ── migrations (files) ───────────────────────────────────────────────────────

def _sql(name):
    with open(os.path.join(_MIG_DIR, name), encoding="utf-8") as fh:
        return fh.read()


def test_g3_migrations_sort_after_f2_and_parse_with_the_runner():
    from app.main import _parse_sql_statements
    files = sorted(f for f in os.listdir(_MIG_DIR) if f.endswith(".sql"))
    assert files[-3:] == list(G3_FILES) or all(f in files for f in G3_FILES)
    assert all(files.index(f) > files.index("20261004_7_platform_workspaces.sql") for f in G3_FILES)
    for f in G3_FILES:
        stmts = _parse_sql_statements(_sql(f))
        assert stmts and all(s.strip() for s in stmts)


def test_g3_migrations_are_idempotent_and_close_the_old_repin_switch():
    for f in G3_FILES:
        sql = _sql(f)
        assert not re.search(r"CREATE TABLE (?!IF NOT EXISTS)", sql), f
        assert not re.search(r"CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)", sql), f
        assert not re.search(r"CREATE FUNCTION", sql), f                      # always CREATE OR REPLACE
        for trig in re.findall(r"CREATE TRIGGER (\w+)", sql):
            assert f"DROP TRIGGER IF EXISTS {trig}" in sql, trig
        assert "UPDATE public.module_catalog" not in sql and "INSERT INTO public.module_catalog" not in sql
    m1 = _sql(G3_FILES[0])
    body = m1.split("CREATE OR REPLACE FUNCTION public.cfg_sites_pin_release()")[1]
    assert "allow_repin" not in body.split("$$;")[0]
    assert "cfg_release_migration_authorizes" in body.split("$$;")[0]
    assert "tenant_isolation" in m1 and "tenant_isolation" in _sql(G3_FILES[2])


def test_creator_guard_and_views_seed_live_in_the_db():
    m2, m3 = _sql(G3_FILES[1]), _sql(G3_FILES[2])
    assert "cfg_user_owns_site" in m2 and "s.submitted_by = p_user OR s.assigned_to = p_user" in m2
    seeds = re.findall(r"\('(\w+)', '([^']+)'", m3.split("FROM (VALUES")[1].split(") AS d(")[0])
    assert [k for k, _ in seeds] == ["awaiting_me", "admin_signoff", "my_cases", "team_queue", "all", "closed"]
    assert "AFTER INSERT OR UPDATE OF enabled ON public.tenant_modules" in m3


def test_module_copy_is_not_mutated_by_planning():
    src, dst = _rts()
    _, st, _ = _at_stage2()
    before = copy.deepcopy(st)
    migrate.plan(st, src, dst, target_version=2)
    assert st == before
