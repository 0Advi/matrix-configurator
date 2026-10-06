import json

from conftest import BD, SAM, WORKSPACE, base
from matrix_bd_bd.adapter import BdAdapter
from workspace_adapters import AdapterHost
from workspace_adapters.sdk import AfterContext, Descriptor, RuleContext, SubmitContext, freeze
from workspace_manifest import validate

import os
DESC = Descriptor.from_json(json.load(open(os.path.join(os.path.dirname(__file__), "..", "examples", "matrix_bd_bd", "adapter.json"))))
HOOKS = BD["adapter"]["hooks"]


def host():
    h = AdapterHost()
    h.install(DESC, BdAdapter())
    return h


def rule(values, stage="draft", action="submit"):
    return base(RuleContext, stage=stage, action=action, values=freeze(values))


def codes(res):
    return sorted(v.code for v in res.value)


def test_registry_satisfies_the_bd_template():
    """The installed adapter is exactly what the template's manifest declares (validator R7)."""
    ws = dict(WORKSPACE, modules=[BD])
    assert validate(ws, adapters=host().registry())["ok"]


def test_fixed_rent_needs_nothing_more():
    assert codes(host().run("validateBusinessRule", rule({"rent_type": "fixed", "expected_rent": 90000}), HOOKS)) == []


def test_staggered_requirements():
    h = host()
    assert codes(h.run("validateBusinessRule", rule({"rent_type": "staggered"}), HOOKS)) == ["required_for_staggered", "required_for_staggered"]
    good = json.dumps([{"year": 1, "percent": 0}, {"year": 2, "percent": 5, "mg": 100000, "dine_in_pct": 8, "delivery_pct": 12}])
    assert codes(h.run("validateBusinessRule", rule({"rent_type": "staggered", "expected_rent": 120000, "staggered_escalation": good}), HOOKS)) == []


def test_schedule_rules():
    h = host()
    rows = [{"year": y, "percent": 5} for y in range(1, 7)]                             # 6 > 5
    assert "too_many_rows" in codes(h.run("validateBusinessRule", rule({"rent_type": "staggered", "expected_rent": 1, "staggered_escalation": json.dumps(rows)}), HOOKS))
    bad = [{"year": 1, "percent": 120}, {"year": 1, "percent": 5}, {"year": 0, "percent": 5, "mg": -1, "delivery_pct": 101}]
    got = codes(h.run("validateBusinessRule", rule({"rent_type": "staggered", "expected_rent": 1, "staggered_escalation": json.dumps(bad)}), HOOKS))
    assert got == ["bad_delivery_pct", "bad_mg", "bad_percent", "bad_year", "duplicate_year"]
    assert codes(h.run("validateBusinessRule", rule({"rent_type": "staggered", "expected_rent": 1, "staggered_escalation": "{oops"}), HOOKS)) == ["schedule_unreadable"]


def test_other_stages_and_decisions_are_ignored():
    assert codes(host().run("validateBusinessRule", rule({"rent_type": "staggered"}, stage="details"), HOOKS)) == []
    assert codes(host().run("validateBusinessRule", rule({"rent_type": "staggered"}, action="approve"), HOOKS)) == []


def test_before_submit_clears_schedule_when_not_staggered_and_canonicalises():
    h = host()
    ctx = base(SubmitContext, stage="draft", values=freeze({"rent_type": "fixed", "expected_rent": 5, "staggered_escalation": "[{\"year\":1,\"percent\":2}]"}))
    r = h.run("beforeSubmit", ctx, HOOKS)
    assert r.ok and r.value.values["staggered_escalation"] is None
    ctx = base(SubmitContext, stage="draft", values=freeze({"rent_type": "staggered", "expected_rent": 5,
                                                              "staggered_escalation": [{"year": 2, "percent": 3}, {"year": 1, "percent": 2}]}))
    r = h.run("beforeSubmit", ctx, HOOKS)
    assert r.value.values["staggered_escalation"] == '[{"percent":2,"year":1},{"percent":3,"year":2}]'


def test_after_approve_emits_loi_deadline_once_per_event():
    h = host()
    ctx = base(AfterContext, actor=SAM, values_on_case={"details": {"expected_loi_days": 21}}, stage="details", action="approve", event_id="ev-9")
    r = h.run("afterApprove", ctx, HOOKS)
    assert r.ok and len(r.value.events) == 1
    e = r.value.events[0]
    assert e.type == "matrix_bd.bd.loi_deadline_set" and e.payload["due_at"] == "2026-10-27T09:00:00+00:00" and e.key == "ev-9:loi_deadline"
    assert h.run("afterApprove", ctx, HOOKS).value == r.value                         # replay → identical effects (idempotent)
    send_back = base(AfterContext, actor=SAM, values_on_case={"details": {"expected_loi_days": 21}}, stage="details", action="send_back", event_id="ev-10")
    assert h.run("afterApprove", send_back, HOOKS).value.events == ()
