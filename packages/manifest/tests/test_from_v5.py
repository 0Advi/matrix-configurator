import json
import os

import pytest

from workspace_manifest import validate
from workspace_manifest.from_v5 import chain, convert, convert_field

HERE = os.path.dirname(os.path.abspath(__file__))
V5 = json.load(open(os.path.join(HERE, "fixtures", "v5_wizard_modules.json"), encoding="utf-8"))["modules"]


def v5_workspace(*modules, builtins=()):
    mods = [{"key": b, "name": b, "type": "builtin", "enabled": True} for b in builtins] + list(modules)
    return {"workspace": {"id": "ws_demo", "name": "Demo", "slug": "demo", "live_version": "v0", "draft_version": "v1"},
            "pipeline": {"editable": False, "stages": [], "note": ""}, "signals": [], "modules": mods, "permissions": []}


@pytest.mark.parametrize("name", sorted(V5))
def test_wizard_templates_convert_and_validate(name):
    out, rep = convert(v5_workspace(V5[name]))
    res = validate(out)
    assert res["ok"], res["findings"]
    assert rep["builtins"] == []


def test_tier_chain_matches_runtime():
    tiers = {"supervisor": True, "executive": True, "business_admin_signoff": True, "delegation": True}
    assert chain({"approvers": ["business_admin", "executive"]}, tiers) == ["executive", "business_admin"]
    assert chain({"approvers": []}, tiers) == ["supervisor"]
    assert chain({"approvers": ["executive"]}, dict(tiers, executive=False)) == ["supervisor"]
    assert chain({"approvers": ["supervisor", "business_admin"]}, dict(tiers, business_admin_signoff=False)) == ["supervisor"]


def test_vendor_stage_mapping():
    out, _ = convert(v5_workspace(V5["vendor"]))
    mod = out["modules"][0]
    s1, s2 = mod["stages"]
    assert s1["submit"] == {"roles": ["executive"]} and "approvals" not in s1
    assert s2["submit"] == {"roles": ["supervisor"]} and s2["approvals"] == [{"role": "business_admin"}]
    assert mod["exit"] == {"on_complete": "approved", "on_reject": "rejected"}
    f = {x["key"]: x for x in s2["fields"]}
    assert f["credit_days"]["validation"] == {"min": 0, "max": 120}
    assert f["msme_certificate"]["validation"] == {"accept": ["application/pdf"], "max_size_mb": 10}


def test_hint_parsing():
    notes = []
    assert convert_field({"key": "pay", "label": "Pay", "kind": "choice", "validation": "advance · net 30 · net 60"}, notes)["options"] == [
        {"value": "advance", "label": "advance"}, {"value": "net_30", "label": "net 30"}, {"value": "net_60", "label": "net 60"}]
    assert convert_field({"key": "amt", "label": "Amt", "kind": "number", "validation": "min 0 · max 25,00,000"}, notes)["validation"] == {"min": 0, "max": 2500000}


def test_builtins_are_reported_and_gates_on_them_flagged():
    mod = dict(V5["vendor"], entry_gate={"match": "all", "conditions": [{"source": "bd", "outcome": "in progress"}], "refusal_message": "x"})
    out, rep = convert(v5_workspace(mod, builtins=("bd", "pex")))
    assert [b["key"] for b in rep["builtins"]] == ["bd", "project_excellence"]
    assert out["modules"][0]["entry_gate"]["conditions"] == [{"source": "bd", "outcome": "in_progress"}]
    codes = {f["code"] for f in validate(out)["findings"]}
    assert "gate_unknown_source" in codes


def test_creator_rule_maps_to_case_creator():
    mod = json.loads(json.dumps(V5["vendor"]))
    mod["stages"][0]["restricted_to"] = "site_creator"
    out, _ = convert(v5_workspace(mod))
    assert out["modules"][0]["stages"][0]["submit"]["restricted_to"] == "case_creator"
    assert validate(out)["ok"]
