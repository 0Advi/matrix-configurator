"""Shared helpers for the matrix-adapters tests (stdlib only)."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTERS = os.path.dirname(HERE)
THIRD_PARTY = os.path.dirname(ADAPTERS)
ROOT = os.path.dirname(THIRD_PARTY)
BB = os.path.join(ROOT, "building-blocks")
SUITES = os.path.join(THIRD_PARTY, "json-logic-compat-tables", "suites")

sys.path.insert(0, ADAPTERS)
sys.path.insert(0, os.path.join(THIRD_PARTY, "panzi-json-logic"))


def node(cmd, payload, script="cli.mjs"):
    """Run a matrix-adapters JS entry point with JSON on stdin; returns parsed JSON."""
    proc = subprocess.run(["node", os.path.join(ADAPTERS, script), cmd], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"node {script} {cmd} failed: {proc.stderr[:2000]}")
    return json.loads(proc.stdout)


def load_json(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return json.load(fh)


def seed():
    return load_json(BB, "from-design", "seed-workspaces.json")


def flow():
    return load_json(BB, "from-matrix-bd", "matrix-bd-flow.json")


def all_manifests():
    """(label, manifest) for every real manifest we have: 3 v5 seeds, 4 wizard templates' module, production flow."""
    s = seed()
    out = [(f"seed:{k}", ws["manifest"]) for k, ws in s["workspaces"].items()]
    f = flow()
    out.append(("matrix-bd-flow", {"modules": f["modules"]}))
    return out


def facts_from_progress(modules, done):
    """Case facts for a set of completed (module_key, stage_order) pairs.

    reached[m] = outcomes of completed stages (+ the module's exit signal once its terminal stage is done);
    stages[m]  = completed stage orders.
    """
    reached, stages = {}, {}
    by_key = {m["key"]: m for m in modules}
    for key, order in sorted(done):
        m = by_key[key]
        st = next(s for s in m["stages"] if s["order"] == order)
        r = reached.setdefault(key, [])
        if st["outcome"] not in r:
            r.append(st["outcome"])
        stages.setdefault(key, []).append(order)
        if st.get("terminal") and m.get("exit_signal") and m["exit_signal"] not in r:
            r.append(m["exit_signal"])
    return {"reached": reached, "stages": stages, "fields": {}}
