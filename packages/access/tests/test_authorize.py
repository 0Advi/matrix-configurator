import copy
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path[:0] = [os.path.dirname(HERE)]

from workspace_access import (CaseResource, MemberResource, Principal, Resource, authorize, can_be_assigned,  # noqa: E402
                              check_ceiling, compile_policy, explain)

ACME = json.load(open(os.path.join(ROOT, "packages", "manifest", "examples", "acme-retail.manifest.json"), encoding="utf-8"))
MBD = json.load(open(os.path.join(ROOT, "templates", "matrix-bd", "workspace.manifest.json"), encoding="utf-8"))
P = compile_policy(ACME, 7)
M = compile_policy(MBD, 3)

ANA = Principal("ana", memberships=frozenset({("site_survey", "executive"), ("fit_out", "executive")}))
SAM = Principal("sam", memberships=frozenset({("site_survey", "supervisor"), ("fit_out", "supervisor")}))
FAY = Principal("fay", memberships=frozenset({("fit_out", "finance_reviewer")}))
BEA = Principal("bea", workspace_roles=frozenset({"business_admin"}))
OLI = Principal("oli", workspace_roles=frozenset({"observer"}))
WIL = Principal("wil", workspace_roles=frozenset({"workspace_admin"}))
OPS = Principal("ops", platform_operator=True)


def case(module="site_survey", stage="capture", step=0, **kw):
    kw.setdefault("created_by", "ana")
    return CaseResource(module=module, case_id="c1", status=kw.pop("status", "in_progress"), stage=stage, step=step, **kw)


def ok(d):
    return d.allowed and not d.as_override


# ── stage actions ─────────────────────────────────────────────────────────────────────────────────
def test_submit_by_actor_and_denials():
    assert ok(authorize(ANA, "stage.submit", case(), P))
    assert authorize(FAY, "stage.submit", case(), P).code == "not_actor"                 # not a member of site_survey
    assert authorize(OLI, "stage.submit", case(), P).code == "read_only"
    assert authorize(ANA, "stage.approve", case(), P).code == "wrong_step"
    assert authorize(ANA, "stage.submit", case(status="completed"), P).code == "closed"


def test_approval_tier_and_override():
    tier1 = case(step=1)
    assert ok(authorize(SAM, "stage.approve", tier1, P))
    assert authorize(ANA, "stage.approve", tier1, P).code == "not_actor"
    d = authorize(BEA, "stage.approve", tier1, P)                                         # business admin: override, recorded
    assert d.allowed and d.as_override and d.code == "override"
    assert authorize(BEA, "stage.submit", tier1, P).code == "wrong_step"                  # an override cannot change the step


def test_separation_of_duties():
    assert authorize(SAM, "stage.approve", case(step=1, acted_in_pass=frozenset({"sam"})), P).code == "separation_of_duties"


def test_assignee_restriction_and_custom_role_tier():
    plan = case("fit_out", "plan")
    assert authorize(ANA, "stage.submit", plan, P).code == "restricted_assignee"
    assert ok(authorize(ANA, "stage.submit", case("fit_out", "plan", assigned_to="ana"), P))
    tier2 = case("fit_out", "plan", step=2)
    assert ok(authorize(FAY, "stage.approve", tier2, P))                                   # custom role finance_reviewer
    assert ok(authorize(FAY, "stage.send_back", tier2, P))
    assert authorize(FAY, "stage.reject", tier2, P).code == "action_not_allowed"          # tier allows approve/send_back only
    assert authorize(BEA, "stage.reject", tier2, P).code == "action_not_allowed"          # not even as override


def test_disabled_module_is_closed_for_everyone():
    m = copy.deepcopy(ACME)
    m["modules"][1]["enabled"] = False
    pol = compile_policy(m, 8)
    for who in (ANA, SAM, BEA, OLI):
        assert authorize(who, "case.view", case("fit_out", "plan"), pol).code == "module_disabled"


# ── visibility ───────────────────────────────────────────────────────────────────────────────────
def test_case_visibility():
    mine, other = case(created_by="ana", step=1), case(created_by="zed", step=1)
    assert ok(authorize(ANA, "case.view", mine, P))
    assert authorize(ANA, "case.view", other, P).code == "not_visible"                    # executive: own (no tier role)
    assert ok(authorize(ANA, "case.view", case(created_by="zed"), P))                     # …but can act on step 0 → sees it
    assert ok(authorize(SAM, "case.view", other, P))                                       # supervisor: grant view_all_cases
    assert ok(authorize(OLI, "case.view", other, P))                                       # observer reads everything
    assert ok(authorize(FAY, "case.view", case("fit_out", "plan", created_by="zed"), P))  # tier role → all
    assert authorize(FAY, "case.view", case(created_by="zed"), P).code == "not_visible"   # not in site_survey at all


def test_visibility_from_manifest_overrides_default():
    m = copy.deepcopy(ACME)
    m["permissions"] = [g for g in m["permissions"] if g["action"] != "view_all_cases"]
    m["modules"][1]["visibility"] = {"supervisor": "actionable"}
    pol = compile_policy(m, 9)
    assert authorize(SAM, "case.view", case("fit_out", "plan", created_by="zed"), pol).code == "not_visible"
    assert ok(authorize(SAM, "case.view", case("fit_out", "plan", created_by="zed", step=1), pol))   # can act now


def test_view_as_only_narrows():
    other = case(created_by="zed", step=1)
    assert ok(authorize(BEA, "case.view", other, P))
    narrowed = Principal("bea", workspace_roles=frozenset({"business_admin"}), view_as="executive")
    assert authorize(narrowed, "case.view", other, P).code == "view_as_narrowed"
    widened = Principal("ana", memberships=ANA.memberships, view_as="business_admin")
    assert authorize(widened, "case.view", other, P).code == "not_visible"                # cannot widen
    assert authorize(narrowed, "stage.approve", case(step=1), P).as_override              # writes ignore view_as


# ── workspace / module actions ───────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("who,action,allowed", [
    (WIL, "release.publish", True), (BEA, "release.publish", False), (SAM, "release.publish", False),
    (WIL, "cases.migrate", True), (BEA, "cases.migrate", False), (WIL, "draft.edit", True),
    (OLI, "audit.view", True), (ANA, "audit.view", False), (OPS, "release.publish", True), (OLI, "draft.edit", False),
])
def test_workspace_actions(who, action, allowed):
    assert authorize(who, action, Resource(), P).allowed is allowed


def test_platform_operator_never_works_cases():
    assert authorize(OPS, "stage.submit", case(), P).code == "platform_operator"
    assert authorize(OPS, "case.view", case(), P).code == "platform_operator"


def test_assign_and_assignee_check():
    assert ok(authorize(SAM, "case.assign", case("fit_out", "plan"), P))
    assert authorize(ANA, "case.assign", case("fit_out", "plan"), P).code == "not_granted"
    assert ok(can_be_assigned(ANA, case("fit_out", "plan"), P))
    assert can_be_assigned(FAY, case("fit_out", "plan"), P).code == "not_assignable"


def test_member_management_and_can_grant():
    m = copy.deepcopy(ACME)
    m["permissions"].append({"action": "manage_members", "roles": ["supervisor"], "modules": ["fit_out"], "can_grant": ["executive"]})
    pol = compile_policy(m, 10)
    assert ok(authorize(BEA, "members.manage", MemberResource(module="site_survey", role="supervisor"), pol))
    assert ok(authorize(SAM, "members.manage", MemberResource(module="fit_out", role="executive"), pol))
    assert authorize(SAM, "members.manage", MemberResource(module="fit_out", role="supervisor"), pol).code == "not_granted"
    assert authorize(SAM, "members.manage", MemberResource(module="site_survey", role="executive"), pol).code == "not_granted"


def test_open_and_module_view():
    assert ok(authorize(ANA, "case.open", Resource(module="site_survey"), P))
    assert authorize(BEA, "case.open", Resource(module="site_survey"), P).as_override
    assert authorize(OLI, "case.open", Resource(module="site_survey"), P).code == "read_only"
    assert ok(authorize(FAY, "module.view", Resource(module="fit_out"), P))
    assert authorize(FAY, "module.view", Resource(module="site_survey"), P).code == "not_member"


def test_inactive_and_explain():
    d = authorize(Principal("ana", memberships=ANA.memberships, active=False), "case.view", case(), P)
    assert d.code == "inactive"
    e = explain(authorize(SAM, "stage.approve", case(step=1), P))
    assert e == {"allowed": True, "code": "ok", "reason": "allowed", "via": "stage capture approval tier 1: supervisor",
                 "as_override": False, "policy_release_version": 7}


# ── Matrix-bd templates: borrowed tiers and subject creator ──────────────────────────────────────
def test_borrowed_tier_project_quality_audit():
    qa2 = case("project", "quality_audit", step=2, created_by="x")
    pe_sup = Principal("pe", memberships=frozenset({("project_excellence", "supervisor")}))
    pr_sup = Principal("pr", memberships=frozenset({("project", "supervisor")}))
    assert authorize(pe_sup, "stage.approve", qa2, M).via == "stage quality_audit approval tier 2: supervisor (from project_excellence)"
    assert authorize(pr_sup, "stage.approve", qa2, M).code == "not_actor"
    assert ok(authorize(pe_sup, "case.view", qa2, M))                                      # can act now → can see it


def test_closure_staffed_by_project_team():
    actuals = case("financial_closure", "actuals", created_by="x")
    pr_exec = Principal("pe2", memberships=frozenset({("project", "executive")}))
    assert ok(authorize(pr_exec, "stage.submit", actuals, M))


def test_launch_creator_review_is_bound_to_the_subject_creator():
    rev = case("launch_approval", "creator_review", created_by="bea", subject_created_by="ana")
    ana = Principal("ana", memberships=frozenset({("launch_approval", "executive")}))
    zed = Principal("zed", memberships=frozenset({("launch_approval", "executive")}))
    assert ok(authorize(ana, "stage.submit", rev, M))
    assert authorize(zed, "stage.submit", rev, M).code == "restricted_subject_creator"


def test_nso_has_no_delegation():
    assert authorize(Principal("bea", workspace_roles=frozenset({"business_admin"})), "case.assign", case("nso", "licensing"), M).code == "delegation_off"


# ── ceiling ──────────────────────────────────────────────────────────────────────────────────────
def test_ceiling():
    assert check_ceiling(ACME) == [] and check_ceiling(MBD) == []
    m = copy.deepcopy(ACME)
    m["permissions"] += [{"action": "publish_release", "roles": ["supervisor"]},
                         {"action": "override_step", "roles": ["executive"]},
                         {"action": "manage_members", "roles": ["supervisor"]}]
    codes = sorted(f["code"] for f in check_ceiling(m))
    assert codes == ["ceiling_scope", "ceiling_scope", "ceiling_unscoped"]
