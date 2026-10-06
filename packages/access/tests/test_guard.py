import json
import os

import pytest

from workspace_access import AccessDenied, CaseResource, Guard, PolicyCache, Principal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ACME = json.load(open(os.path.join(ROOT, "packages", "manifest", "examples", "acme-retail.manifest.json"), encoding="utf-8"))
V8 = json.loads(json.dumps(ACME))
V8["modules"][0]["stages"][0]["approvals"] = [{"role": "business_admin"}]       # live v8: capture tier 1 moved to BA

PEOPLE = {"sam": Principal("sam", memberships=frozenset({("site_survey", "supervisor")})),
          "bea": Principal("bea", workspace_roles=frozenset({"business_admin"})),
          "wil": Principal("wil", workspace_roles=frozenset({"workspace_admin"}))}
CASES = {"old": (CaseResource(module="site_survey", case_id="old", status="in_progress", stage="capture", step=1, created_by="ana"),
                 ("rel-7", 7, ACME))}


@pytest.fixture
def g():
    audit = []
    guard = Guard(load_principal=lambda ws, u: PEOPLE[u], load_live_release=lambda ws: ("rel-8", 8, V8),
                  load_case=lambda ws, c: CASES[c], audit=lambda *a: audit.append(a))
    guard.audit_log = audit
    return guard


def test_case_actions_use_the_pinned_release(g):
    d = g.check("sam", "ws", "stage.approve", case_id="old")         # v7 (pinned): supervisor approves capture
    assert d.allowed and d.release_version == 7 and g.audit_log == []


def test_denial_is_problem_json_and_audited(g):
    with pytest.raises(AccessDenied) as e:
        g.check("sam", "ws", "release.publish")
    prob = e.value.problem()
    assert prob["status"] == 403 and prob["code"] == "not_granted" and prob["release_version"] == 8
    assert g.audit_log[-1][1] == "release.publish" and g.audit_log[-1][2]["allowed"] is False


def test_override_is_audited(g):
    d = g.check("bea", "ws", "stage.approve", case_id="old")
    assert d.as_override and g.audit_log[-1][2]["as_override"] is True


def test_view_as_header_narrows(g):
    assert g.check("bea", "ws", "case.view", case_id="old").allowed
    with pytest.raises(AccessDenied) as e:
        g.check("bea", "ws", "case.view", case_id="old", view_as="executive")
    assert e.value.decision.code == "view_as_narrowed"


def test_members_manage_and_cache():
    cache = PolicyCache(size=1)
    g = Guard(lambda ws, u: PEOPLE[u], lambda ws: ("rel-8", 8, V8), lambda ws, c: CASES[c], cache=cache)
    assert g.check("bea", "ws", "members.manage", module="fit_out", member_role="finance_reviewer").allowed
    g.check("wil", "ws", "release.publish")
    assert cache.compiles == 1                                          # same live release → compiled once
    g.check("sam", "ws", "stage.approve", case_id="old")               # pinned v7 evicts v8 (size 1)
    g.check("wil", "ws", "release.publish")
    assert cache.compiles == 3
