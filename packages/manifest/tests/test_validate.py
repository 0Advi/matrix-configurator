import copy
import json
import os

import pytest

from workspace_manifest import validate

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMPLE = os.path.join(ROOT, "examples", "acme-retail.manifest.json")
FIXTURES = json.load(open(os.path.join(HERE, "fixtures", "invalid_cases.json"), encoding="utf-8"))


def load_example():
    return json.load(open(EXAMPLE, encoding="utf-8"))


def _walk(doc, path):
    parts = [int(p) if p.isdigit() else p for p in path.split("/")]
    node = doc
    for p in parts[:-1]:
        node = node[p]
    return node, parts[-1]


def apply_ops(doc, ops):
    for op in ops:
        node, last = _walk(doc, op["path"])
        value = op.get("value")
        if isinstance(value, dict) and "$copy" in value:
            src, k = _walk(doc, value["$copy"])
            value = copy.deepcopy(src[k])
        if op["op"] == "set":
            node[last] = value
        elif op["op"] == "del":
            del node[last]
        elif op["op"] == "append":
            node[last].append(value)
        else:
            raise ValueError(op)
    return doc


def test_example_is_clean():
    rep = validate(load_example())
    assert rep["ok"], rep["findings"]
    assert rep["findings"] == []


def test_example_shape():
    m = load_example()
    assert len(m["modules"]) == 2 and all(len(x["stages"]) == 3 for x in m["modules"])
    assert any(x["entry_gate"] for x in m["modules"]) and any(s.get("gate") for x in m["modules"] for s in x["stages"])
    assert any(s.get("approvals") for x in m["modules"] for s in x["stages"]) and all(x.get("views") for x in m["modules"])


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=[c["name"] for c in FIXTURES["cases"]])
def test_rule_fixture(case):
    doc = apply_ops(load_example(), case["ops"])
    rep = validate(doc, adapters=case.get("adapters"))
    hits = [f for f in rep["findings"] if f["code"] == case["expect"]["code"] and f["severity"] == case["expect"]["severity"]]
    assert hits, json.dumps(rep["findings"], indent=1)
    assert hits[0]["rule"] == case["rule"]
    if case["expect"]["severity"] == "error":
        assert not rep["ok"]


def test_every_rule_has_a_fixture():
    rules = {c["rule"] for c in FIXTURES["cases"]}
    assert rules >= {"R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"}


def test_any_gate_with_one_live_condition_is_not_dead():
    m = load_example()
    m["modules"][1]["entry_gate"] = {"match": "any", "refusal_message": "x", "conditions": [
        {"source": "site_survey", "outcome": "approved"}, {"source": "site_survey", "outcome": "done"}]}
    rep = validate(m)
    assert rep["ok"], rep["findings"]
    assert [f["code"] for f in rep["findings"]] == ["unreachable_outcome"]
    assert rep["findings"][0]["severity"] == "warning"


def test_dead_chain_propagates():
    """A waits on B, B waits on a disabled C → both A and B are dead, not only B."""
    m = load_example()
    third = copy.deepcopy(m["modules"][0])
    third["key"], third["enabled"], third["views"] = "permit_desk", False, []
    m["modules"].append(third)
    m["modules"][0]["entry_gate"] = {"match": "all", "refusal_message": "x", "conditions": [{"source": "permit_desk", "outcome": "approved"}]}
    rep = validate(m)
    dead = {f["module"] for f in rep["findings"] if f["code"] == "dead_gate"}
    assert dead == {"site_survey", "fit_out"}


def test_adapter_registered_ok():
    m = load_example()
    m["modules"][1]["adapter"] = {"key": "permits", "version": "1.0.0", "hooks": ["syncExternalState"]}
    rep = validate(m, adapters={"permits": {"versions": ["1.0.0"], "hooks": ["syncExternalState", "beforeOpen"]}})
    assert rep["ok"] and rep["findings"] == []


def test_non_object():
    assert validate([])["ok"] is False


def test_generic_additions_validate():
    """Task 4 additions: subject_creator + restrict_roles, borrowed approval tier, approval fields, rework send-back."""
    m = load_example()
    plan = m["modules"][1]["stages"][0]
    plan["submit"] = {"roles": ["executive", "supervisor"], "restricted_to": "subject_creator", "restrict_roles": ["executive"]}
    plan["send_back_to"] = ["plan"]
    handover = m["modules"][1]["stages"][2]
    handover["approvals"].append({"role": "supervisor", "module": "site_survey", "actions": ["approve", "send_back"], "label": "Survey lead sign-off"})
    handover["approvals"][0]["fields"] = [{"key": "accepted_on", "label": "Accepted on", "type": "date", "required": True}]
    rep = validate(m)
    assert rep["ok"], rep["findings"]
    # approval fields are addressable by gates/rollups like stage fields
    m["modules"][1]["stages"][1]["gate"]["conditions"].append({"source": "fit_out", "stage": "plan", "field": "budget", "op": "lte", "value": 100})
    assert validate(m)["ok"]
