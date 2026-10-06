import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(TPL))
sys.path.insert(0, os.path.join(ROOT, "packages", "manifest"))
sys.path.insert(0, TPL)

from workspace_manifest import validate  # noqa: E402
import build_templates as B  # noqa: E402

KEYS = B.ORDER
TEMPLATES = {k: json.load(open(os.path.join(TPL, f"{k}.template.json"), encoding="utf-8")) for k in KEYS}
WORKSPACE = json.load(open(os.path.join(TPL, "workspace.manifest.json"), encoding="utf-8"))
REGISTRY = json.load(open(os.path.join(TPL, "adapters.registry.json"), encoding="utf-8"))


def test_build_is_reproducible():
    before = {f: open(os.path.join(TPL, f), encoding="utf-8").read() for f in os.listdir(TPL) if f.endswith(".json")}
    subprocess.run([sys.executable, os.path.join(TPL, "build_templates.py")], check=True, capture_output=True)
    after = {f: open(os.path.join(TPL, f), encoding="utf-8").read() for f in before}
    assert before == after


def test_the_eight_requested_builtins_plus_finance_are_templates():
    assert set(KEYS) >= {"bd", "legal", "design", "project_excellence", "project", "nso", "launch_approval", "financial_closure"}
    assert "finance_ca" in KEYS  # gates of Design and NSO wait on it


def test_composed_workspace_is_valid_and_has_no_builtins():
    rep = validate(WORKSPACE, adapters=REGISTRY)
    assert rep["ok"] and rep["warnings"] == 0, rep["findings"]
    for m in WORKSPACE["modules"]:
        assert not {"type", "implementation", "route", "status_source"} & set(m)


@pytest.mark.parametrize("key", KEYS)
def test_template_shape(key):
    t = TEMPLATES[key]
    assert t["template"]["key"] == f"matrix-bd/{key}" and t["template"]["visibility"] == "customer-private"
    assert t["module"] == next(m for m in WORKSPACE["modules"] if m["key"] == key)
    s = t["summary"]
    assert s["stages"] and all({"submit", "approvals", "fields", "outcome"} <= set(st) for st in s["stages"])
    assert "exit_outcomes" in s and "entry_gate" in s and "approval_tiers" in s
    assert set(t["behaviour"]) == {"generic", "matrix_bd_specific"} and t["behaviour"]["generic"]
    # declared adapter hooks == the module's adapter.hooks == the registry entry
    hooks = sorted({h["hook"] for h in t["adapter_hooks"]})
    if hooks:
        assert t["module"]["adapter"]["hooks"] == hooks == REGISTRY[f"matrix_bd.{key}"]["hooks"]
        assert all(h["purpose"] and h["why_not_generic"] and h["matrix_bd_source"] for h in t["adapter_hooks"])
    else:
        assert "adapter" not in t["module"]


@pytest.mark.parametrize("key", KEYS)
def test_template_validates_with_only_its_requirements(key):
    """A template + the modules it requires (transitively) forms a valid workspace on its own."""
    need, todo = set(), [key]
    while todo:
        k = todo.pop()
        if k not in need:
            need.add(k)
            todo += TEMPLATES[k]["requires"]["modules"]
    ws = dict(WORKSPACE, modules=[TEMPLATES[k]["module"] for k in KEYS if k in need])
    rep = validate(ws, adapters=REGISTRY)
    assert rep["ok"], rep["findings"]


def test_every_flow_field_lands_exactly_once():
    flow_keys = [B.RENAMED.get(f["key"], f["key"]) for m in B.FLOW["modules"] for s in m["stages"] for f in s["fields"]]
    placed = [f["key"] for f in WORKSPACE["subjects"][0]["fields"]]
    for m in WORKSPACE["modules"]:
        for s in m["stages"]:
            placed += [f["key"] for f in s.get("fields", [])] + [f["key"] for a in s.get("approvals", []) for f in a.get("fields", [])]
    assert len(flow_keys) == 114  # the corrected flow model (README of the extraction still says 113)
    assert sorted(placed) == sorted(flow_keys)


def test_no_brand_or_matrix_table_names_in_templates():
    text = json.dumps([t["module"] for t in TEMPLATES.values()]).lower()
    for banned in ("starbucks", "blue tokai", "bluetokai", "btc cafe", "sites.status", "supabase"):
        assert banned not in text, banned


def test_gate_chain_matches_production():
    gates = {m["key"]: sorted(c["source"] for c in (m["entry_gate"] or {}).get("conditions", [])) for m in WORKSPACE["modules"]}
    assert gates == {"bd": [], "legal": ["bd"], "finance_ca": ["bd"], "design": ["finance_ca", "legal"], "project_excellence": ["design"],
                     "project": ["design"], "nso": ["finance_ca"], "launch_approval": ["nso"], "financial_closure": ["launch_approval"]}
