"""Gate compiler + evaluator on the project's REAL data.

Data: building-blocks/from-design/seed-workspaces.json (3 v5 workspaces) and
building-blocks/from-matrix-bd/matrix-bd-flow.json (production Blue Tokai, 9 modules / 36 stages).
"""
import itertools
import json
import os
import subprocess
import unittest

from _util import BB, all_manifests, facts_from_progress, flow, node, seed

import gates


class CompileOnRealData(unittest.TestCase):
    def test_python_and_js_compile_identical_rules_for_every_manifest(self):
        for label, manifest in all_manifests():
            with self.subTest(manifest=label):
                py = gates.compile_manifest(manifest)
                js = node("compile-manifest", manifest)
                self.assertEqual(json.dumps(py, sort_keys=True), json.dumps(js, sort_keys=True))

    def test_every_compiled_rule_is_dialect_clean(self):
        n = 0
        for label, manifest in all_manifests():
            for key, m in gates.compile_manifest(manifest)["modules"].items():
                for part in ("entry_gate", "rollup"):
                    self.assertEqual(gates.lint(m[part]), [], f"{label}/{key}/{part}")
                    n += 1
        self.assertGreaterEqual(n, 2 * (9 * 4))

    def test_v5_document_form_compiles_like_manifest_form(self):
        # the document (stashOf) uses {match, conds:[{src,out}], refusal}; the manifest {match, conditions, refusal_message}
        ws = seed()["workspaces"]["bluetokai"]
        doc_mods = {m["key"]: m for m in ws["document"]["modules"]}
        for m in ws["manifest"]["modules"]:
            self.assertEqual(gates.compile_gate(m["entry_gate"]), gates.compile_gate(doc_mods[m["key"]].get("gate")))


class ProductionFlowSemantics(unittest.TestCase):
    """Walk the production flow and check every entry gate opens exactly when it should."""

    @classmethod
    def setUpClass(cls):
        cls.mods = flow()["modules"]
        cls.by_key = {m["key"]: m for m in cls.mods}

    def gate(self, key):
        return self.by_key[key]["entry_gate"]

    def done_through(self, *pairs):
        done = set()
        for key, upto in pairs:
            done |= {(key, o) for o in range(1, upto + 1)}
        return facts_from_progress(self.mods, done)

    def test_bd_has_no_gate(self):
        self.assertEqual(gates.check_gate(self.gate("bd"), {}), (True, None, []))

    def test_legal_waits_for_loi(self):
        ok, refusal, unmet = gates.check_gate(self.gate("legal"), self.done_through(("bd", 3)))
        self.assertFalse(ok)
        self.assertIn("locked", refusal.lower())
        self.assertEqual(unmet, [{"source": "bd", "outcome": "done"}])
        self.assertTrue(gates.check_gate(self.gate("legal"), self.done_through(("bd", 4)))[0])

    def test_design_is_a_join_of_legal_and_finance(self):
        f = self.done_through(("bd", 4), ("legal", 1))
        ok, _, unmet = gates.check_gate(self.gate("design"), f)
        self.assertFalse(ok)
        self.assertEqual([c["source"] for c in unmet], ["finance_ca"])
        f = self.done_through(("bd", 4), ("legal", 1), ("finance_ca", 3))
        self.assertTrue(gates.check_gate(self.gate("design"), f)[0])

    def test_nso_opens_on_finance_not_project(self):
        # production: NSO opens when Finance/CA is approved (seed wrongly says Project approved)
        f = self.done_through(("bd", 4), ("finance_ca", 3))
        self.assertTrue(gates.check_gate(self.gate("nso"), f)[0])
        seed_nso = next(m for m in seed()["workspaces"]["bluetokai"]["manifest"]["modules"] if m["key"] == "nso")
        self.assertFalse(gates.check_gate(seed_nso["entry_gate"], f)[0])

    def test_any_match(self):
        g = {"match": "any", "conditions": [{"source": "legal", "outcome": "approved"},
                                             {"source": "finance_ca", "outcome": "approved"}]}
        self.assertFalse(gates.check_gate(g, self.done_through(("bd", 4)))[0])
        self.assertTrue(gates.check_gate(g, self.done_through(("bd", 4), ("finance_ca", 3)))[0])

    def test_stage_level_gates_from_x_matrix(self):
        # G-A: x-matrix.stageLevelGates written as matrix-gate/1 stage conditions
        nso_stage2 = {"match": "all", "conditions": [{"source": "nso", "stage": 1}, {"source": "project", "stage": 1}]}
        nso_stage3 = {"match": "all", "conditions": [{"source": "project", "stage": 5}, {"source": "legal", "stage": 3}]}
        f = self.done_through(("bd", 4), ("finance_ca", 3), ("nso", 1))
        self.assertFalse(gates.check_gate(nso_stage2, f)[0])
        f = self.done_through(("bd", 4), ("finance_ca", 3), ("nso", 1), ("project", 1))
        self.assertTrue(gates.check_gate(nso_stage2, f)[0])
        self.assertFalse(gates.check_gate(nso_stage3, f)[0])
        f = self.done_through(("bd", 4), ("legal", 3), ("finance_ca", 3), ("nso", 2), ("project", 5))
        self.assertTrue(gates.check_gate(nso_stage3, f)[0])

    def test_field_condition_ddr_verdict(self):
        # G-E: "published positive DDR" = a field verdict, not a roll-up
        g = {"match": "all", "conditions": [{"source": "legal", "stage": 1},
                                             {"source": "legal", "field": "ddr_verdict", "op": "===", "value": "positive"}]}
        f = self.done_through(("bd", 4), ("legal", 1))
        f["fields"] = {"legal": {"ddr_verdict": "negative"}}
        self.assertFalse(gates.check_gate(g, f)[0])
        f["fields"] = {"legal": {"ddr_verdict": "positive"}}
        self.assertTrue(gates.check_gate(g, f)[0])

    def test_python_and_js_agree_on_every_flow_prefix(self):
        """For every prefix of the flow order (stage by stage), every gate verdict matches across languages."""
        order = ["bd", "finance_ca", "legal", "design", "pex", "project", "nso", "launch_approval", "financial_closure"]
        steps = [(k, s["order"]) for k in order for s in self.by_key[k]["stages"]]
        all_gates = [m["entry_gate"] for m in self.mods] + [
            {"match": "all", "conditions": [{"source": "nso", "stage": 1}, {"source": "project", "stage": 1}]},
            {"match": "any", "conditions": [{"source": "project", "stage": 5}, {"source": "legal", "outcome": "done"}]},
        ]
        checked = 0
        for i in range(len(steps) + 1):
            facts = facts_from_progress(self.mods, set(steps[:i]))
            js = node("gates", {"gates": all_gates, "facts": facts})
            for g, j in zip(all_gates, js):
                ok, refusal, unmet = gates.check_gate(g, facts)
                self.assertEqual((ok, refusal, unmet), (j["open"], j["refusal"], j["unmet"]))
                checked += 1
        print(f"\n  gate verdicts compared across languages: {checked}")
        self.assertEqual(checked, (len(steps) + 1) * len(all_gates))


class Rollups(unittest.TestCase):
    """compile_rollup == the v5-port evaluateRollup (building-blocks/from-design/validation.mjs)."""

    VALUES = ["yes", "no", "n/a", "done", "blocked", "ready", ""]

    def grid(self):
        cases = []
        rollups = [{"strategy": "all_positive"}, {"strategy": "any_negative"},
                   {"strategy": "count_at_least", "n": 2, "of": 3}, {"strategy": "custom"}]
        for r in rollups:
            for n in range(0, 4):
                for combo in itertools.product(self.VALUES, repeat=n):
                    cases.append({"rollup": r, "checks": list(combo), "sum": None})
        for s in [None, "", 0, 100, 2499999, 2500000, 3000000]:
            cases.append({"rollup": {"strategy": "sum_under", "limit": "25,00,000"}, "checks": [], "sum": s})
        return cases

    def test_python_js_and_v5_port_agree(self):
        cases = self.grid()
        py = [gates.rollup_verdict(c["rollup"], c["checks"], c["sum"]) for c in cases]
        js = node("rollups", cases)
        ref_src = (
            "import { evaluateRollup } from '" + os.path.join(BB, "from-design", "validation.mjs") + "';"
            "const cs = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            "process.stdout.write(JSON.stringify(cs.map(c => evaluateRollup(c.rollup, c.checks, c.sum))));"
        )
        ref = json.loads(subprocess.run(
            ["node", "--input-type=module", "-e", "import { createRequire } from 'node:module';"
             "const require = createRequire(import.meta.url);" + ref_src],
            input=json.dumps(cases), capture_output=True, text=True, check=True).stdout)
        self.assertEqual(py, js)
        diffs = [(c, p, r) for c, p, r in zip(cases, py, ref) if p != r]
        print(f"\n  roll-up verdicts: {len(cases)} cases, {len(diffs)} differ from the v5 port")
        self.assertEqual(diffs, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
