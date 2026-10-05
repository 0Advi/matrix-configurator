"""The vendored JsonLogic engines against the community compat suite, and against each other.

* json-logic-js 2.0.5 (JS)  must pass all 278 cases of compatible.json (the classic json-logic tests).
* panzi-json-logic 1.0.1 (Py) passes 277/278; the single failure is a known upstream bug
  (reduce does not evaluate a rule given as the initial value) which the dialect lint forbids.
* Differential: on EVERY compat case (1138, all 49 suites) whose rule passes the matrix-gate/1
  lint, the two engines return identical results. Cases failing lint are where they diverge.
"""
import json
import math
import os
import unittest

from _util import SUITES, load_json, node

from json_logic import jsonLogic
import gates


def load_cases():
    cases = []
    for name in load_json(SUITES, "index.json"):
        for c in load_json(SUITES, name):
            if isinstance(c, dict):
                cases.append((name, c))
    return cases


def py_eval(rule, data):
    try:
        r = jsonLogic(rule, data)
        if isinstance(r, float) and not math.isfinite(r):
            return {"ok": True, "special": "NaN" if math.isnan(r) else ("Infinity" if r > 0 else "-Infinity")}
        return {"ok": True, "result": r}
    except Exception as e:  # noqa: BLE001 — the suite expects errors for some cases
        return {"ok": False, "error": str(e)}


def same(a, b):
    if a["ok"] != b["ok"]:
        return False
    if not a["ok"]:
        return True
    if "special" in a or "special" in b:
        return a.get("special") == b.get("special")
    x, y = a["result"], b["result"]
    if isinstance(x, bool) or isinstance(y, bool):
        return type(x) is type(y) and x == y
    if isinstance(x, (int, float)) and isinstance(y, (int, float)):
        return abs(x - y) < 1e-9
    return json.dumps(x, sort_keys=True) == json.dumps(y, sort_keys=True)


def passes(r, case):
    if "error" in case:
        return not r["ok"]
    if not r["ok"] or "special" in r:
        return False
    x, e = r["result"], case["result"]
    if isinstance(e, bool) or isinstance(x, bool):
        return type(x) is type(e) and x == e
    if isinstance(x, (int, float)) and isinstance(e, (int, float)):
        return abs(x - e) < 1e-9
    return x == e


class JsonLogicEngines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = load_cases()
        cls.js = node("eval", [{"rule": c["rule"], "data": c.get("data")} for _, c in cls.cases])
        cls.py = [py_eval(c["rule"], c.get("data")) for _, c in cls.cases]

    def test_suite_loaded(self):
        self.assertEqual(len(self.cases), 1138)

    def test_js_passes_classic_suite(self):
        res = [passes(j, c) for (f, c), j in zip(self.cases, self.js) if f == "compatible.json"]
        self.assertEqual((sum(res), len(res)), (278, 278))

    def test_python_passes_classic_suite_but_one_known_bug(self):
        fails = [c for (f, c), p in zip(self.cases, self.py) if f == "compatible.json" and not passes(p, c)]
        self.assertEqual(len(fails), 1)
        self.assertEqual(fails[0]["rule"]["reduce"][2], {"var": "start_with"})  # initial value given as a rule
        self.assertTrue(gates.lint(fails[0]["rule"]), "the dialect lint must reject this shape")

    def test_engines_agree_on_every_lint_clean_case(self):
        clean = disagree = 0
        bad = []
        for (f, c), j, p in zip(self.cases, self.js, self.py):
            if gates.lint(c["rule"]):
                continue
            clean += 1
            if not same(j, p):
                disagree += 1
                bad.append((f, c["description"], j, p))
        print(f"\n  differential: {clean} lint-clean compat cases, {disagree} disagreements")
        self.assertGreaterEqual(clean, 500)
        self.assertEqual(bad, [])

    def test_lint_is_identical_in_both_languages(self):
        # the JS linter must accept/reject exactly the same rules as the Python one
        rules = [c["rule"] for _, c in self.cases]
        js_lint = node("eval", [{"rule": {"!!": [True]}, "data": None}])  # warm-up / sanity
        self.assertEqual(js_lint, [{"ok": True, "result": True}])
        js = node("lint", rules, script="test/lint-bridge.mjs")
        py = [bool(gates.lint(r)) for r in rules]
        self.assertEqual(js, py)


if __name__ == "__main__":
    unittest.main(verbosity=2)
