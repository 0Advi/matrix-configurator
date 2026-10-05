"""The reference custom-module runtime on REAL data.

* every custom module in the v5 seeds (Starbucks, Burger King) and every wizard template runs end to end;
* the whole production Blue Tokai flow (9 modules / 36 stages, matrix-bd-flow.json) runs as generic
  modules for one site, with entry gates opening in the production order;
* tier approvals, send-backs, loops, forward-only verdicts, stage-level gates, delegation, observer,
  admin override, separation of duties, version pinning and the hash-chained audit trail.
Needs jsonschema==4.26.0 (form validation); skips otherwise.
"""
import copy
import unittest

from _util import flow, seed

try:
    import jsonschema  # noqa: F401
    HAVE_JSONSCHEMA = True
except ImportError:
    HAVE_JSONSCHEMA = False

import gates
from runtime import (F2_OUTCOMES, F2_VERDICTS, Actor, ModuleRuntime, Refusal, approval_row, module_record_row,
                     site_facts, verify_chain)

SITE = "site-1"
POSITIVE = ["yes", "done", "approved", "positive", "ready", "received", "active"]
EXEC = Actor("u-exec", "executive", (SITE,))
SUP = Actor("u-sup", "supervisor")
ADMIN = Actor("u-admin", "business_admin")
OBS = Actor("u-obs", "observer")
BY_ROLE = {"executive": EXEC, "supervisor": SUP, "business_admin": ADMIN}


def fill(form):
    """Valid values for a compiled stage form (positive answers for roll-up fields)."""
    out = {}
    for k, s in form["schema"]["properties"].items():
        if "enum" in s:
            out[k] = next((e for e in s["enum"] if e in POSITIVE), s["enum"][0])
        elif s.get("type") == "boolean":
            out[k] = True
        elif s.get("type") == "number":
            out[k] = s.get("minimum", 1)
        elif s.get("format") == "date":
            out[k] = "2026-10-04"
        elif "pattern" in s:
            out[k] = "27AAPFU0939F1ZV" if "A-Z" in s["pattern"] else "https://example.com/x"
        else:
            out[k] = "file-123" if k.endswith(("_document", "_file", "_upload")) else "sample"
    return out


def drive(rt, state, facts=None, events=None):
    """Run one case to the end with the right actor at every step."""
    events = events if events is not None else []
    for _ in range(100):
        nxt = rt.next_step(state)
        if not nxt:
            return state, events
        actor = BY_ROLE[nxt["role"]]
        if nxt["kind"] == "submit":
            state, ev = rt.act(state, actor, "submit", {"values": fill(nxt["form"])}, facts)
        else:
            state, ev = rt.act(state, actor, "approve", {}, facts)
        events += ev
    raise AssertionError("did not terminate")


@unittest.skipUnless(HAVE_JSONSCHEMA, "pip install jsonschema==4.26.0")
class CustomModulesFromTheDesign(unittest.TestCase):
    def custom_modules(self):
        s = seed()
        for ws in ("starbucks", "burgerking"):
            for m in s["workspaces"][ws]["manifest"]["modules"]:
                if m["type"] == "custom":
                    yield f"{ws}/{m['key']}", m
        for name, t in s["wizardTemplates"].items():
            if name != "blank":
                yield f"wizard/{name}", t["manifest"]

    def test_every_custom_module_runs_end_to_end(self):
        n = 0
        for label, m in self.custom_modules():
            with self.subTest(module=label):
                rt = ModuleRuntime(m, "v1", clock=lambda: "2026-10-04T00:00:00+00:00")
                facts = {"reached": {c["source"]: [c["outcome"]] for c in (m.get("entry_gate") or {}).get("conditions", [])}}
                state, events = rt.new_case("c1", SITE, facts)
                self.assertEqual(state["status"], "open", label)
                state, events = drive(rt, state, facts, events)
                self.assertEqual(state["status"], "completed", label)
                self.assertIn(rt.m.get("exit_signal") or "approved", state["reached"])
                self.assertTrue(verify_chain(events))
                n += 1
        print(f"\n  custom modules run end to end: {n}")
        self.assertGreaterEqual(n, 10)

    def test_vendor_template_tiers_and_validation(self):
        m = seed()["wizardTemplates"]["vendor"]["manifest"]
        rt = ModuleRuntime(m, "v1")
        state, events = rt.new_case("c1", SITE)
        self.assertEqual(rt.chain(rt.stages[1]), ["supervisor", "business_admin"])
        with self.assertRaises(Refusal) as e:
            rt.act(state, EXEC, "submit", {"values": {"vendor_name": "Acme", "gst_number": "not-a-gstin"}})
        self.assertEqual(e.exception.code, "invalid_form")
        with self.assertRaises(Refusal) as e:
            rt.act(state, Actor("u-x", "executive"), "submit", {"values": {"vendor_name": "A", "gst_number": "27AAPFU0939F1ZV"}})
        self.assertEqual(e.exception.code, "no_delegation")
        with self.assertRaises(Refusal) as e:
            rt.act(state, OBS, "submit", {"values": {}})
        self.assertEqual(e.exception.code, "observer_read_only")
        state, ev = rt.act(state, EXEC, "submit", {"values": {"vendor_name": "Acme", "gst_number": "27AAPFU0939F1ZV"}})
        self.assertEqual((state["stage"], state["step"]), (2, 0))
        # roll-up flags: text/file/number fields marked affects_outcome cannot feed all_positive
        _, ignored = rt.rollup_inputs(state)
        self.assertEqual(ignored, ["gst_number", "msme_certificate", "credit_days"])


@unittest.skipUnless(HAVE_JSONSCHEMA, "pip install jsonschema==4.26.0")
class ProductionFlowAsGenericModules(unittest.TestCase):
    # G-E: production roll-up fields whose options are not yes/no/n/a need an outcome map to be scored
    OUTCOME_MAP = {"positive": "yes", "negative": "no", "done": "yes", "received": "yes", "active": "yes",
                   "ready": "yes", "pending": "", "ordered": ""}

    def setUp(self):
        self.mods = flow()["modules"]
        self.mapped = []
        for m in self.mods:
            for st in m["stages"]:
                for f in st["fields"]:
                    if f["affects_outcome"] and f["kind"] == "choice" and f["validation"] not in ("yes · no · n/a", None):
                        f["outcome_map"] = self.OUTCOME_MAP
                        self.mapped.append(f"{m['key']}.{f['key']}")
        self.rts = {m["key"]: ModuleRuntime(m, "v1") for m in self.mods}

    def test_without_outcome_maps_legal_and_nso_park(self):
        raw = flow()["modules"]
        rts = {m["key"]: ModuleRuntime(m, "v1") for m in raw}
        parked = []
        for key in ("legal", "nso"):
            src = {"legal": {"bd": ["done"]}, "nso": {"finance_ca": ["approved"]}}[key]
            state, _ = rts[key].new_case("c", SITE, {"reached": src})
            state, _ = drive(rts[key], state, {"reached": src, "stages": {"project": [1, 5]}})
            parked.append((key, state["status"], state["verdict"]))
        print(f"\n  v5 roll-up vocabulary alone: {parked}; fields needing an outcome map: {len(self.mapped)}")
        self.assertEqual([p[1] for p in parked], ["parked", "parked"])
        self.assertEqual(len(self.mapped), 8)

    def test_whole_blue_tokai_flow_runs_and_gates_open_in_production_order(self):
        cases, events, opened = {}, [], []
        for key, rt in self.rts.items():
            cases[key], ev = rt.new_case(f"case-{key}", SITE, {})
            events += ev
            if cases[key]["status"] == "open":
                opened.append(key)
        for _ in range(500):
            facts = site_facts([(k, s, self.rts[k]) for k, s in cases.items()])
            for k in cases:
                before = cases[k]["status"]
                cases[k], ev = self.rts[k].refresh(cases[k], facts)
                events += ev
                if before == "locked" and cases[k]["status"] == "open":
                    opened.append(k)
            todo = [k for k in cases if self.rts[k].next_step(cases[k])]
            if not todo:
                break
            k = todo[0]
            nxt = self.rts[k].next_step(cases[k])
            actor = BY_ROLE[nxt["role"]]
            act = ("submit", {"values": fill(nxt["form"])}) if nxt["kind"] == "submit" else ("approve", {})
            cases[k], ev = self.rts[k].act(cases[k], actor, *act, facts=facts)
            events += ev
        self.assertEqual({k: s["status"] for k, s in cases.items()}, {k: "completed" for k in cases})
        self.assertEqual(opened[0], "bd")
        pos = {k: i for i, k in enumerate(opened)}
        self.assertLess(pos["finance_ca"], pos["nso"])          # production: NSO opens on Finance/CA
        self.assertLess(max(pos["legal"], pos["finance_ca"]), pos["design"])
        self.assertEqual(opened[-2:], ["launch_approval", "financial_closure"])
        per_case = {}
        for e in events:
            per_case.setdefault(e["case"], []).append(e)
        self.assertTrue(all(verify_chain(v) for v in per_case.values()))
        print(f"\n  production flow: 9 modules completed, {len(events)} audit events, open order: {' > '.join(opened)}")

    def test_finance_sendback_to_pending(self):
        rt = self.rts["finance_ca"]
        facts_closed = {"reached": {"bd": ["submitted"]}}
        state, _ = rt.new_case("c-fin", SITE, facts_closed)
        with self.assertRaises(Refusal) as e:
            rt.act(state, EXEC, "submit", {"values": {}}, facts_closed)
        self.assertEqual(e.exception.code, "gate_closed")
        self.assertEqual(e.exception.message, rt.m["entry_gate"]["refusal_message"])
        facts = {"reached": {"bd": ["done"]}}
        state, _ = rt.refresh(state, facts)
        state, _ = rt.act(state, EXEC, "submit", {"values": fill(rt.forms[1])}, facts)
        self.assertEqual(rt.next_step(state)["role"], "supervisor")
        with self.assertRaises(Refusal):
            rt.act(state, SUP, "send_back", {}, facts)  # reason required
        state, ev = rt.act(state, SUP, "send_back", {"reason": "KYC blurry"}, facts)
        self.assertEqual((state["stage"], state["step"], state["completed"]), (1, 0, []))
        self.assertEqual(ev[0]["type"], "sent_back")

    def test_legal_negative_ddr_loop_and_reject(self):
        rt = self.rts["legal"]
        facts = {"reached": {"bd": ["done"]}}
        state, _ = rt.new_case("c-legal", SITE, facts)
        state, _ = rt.act(state, SUP, "submit", {"values": fill(rt.forms[1])}, facts)
        state, _ = rt.act(state, SUP, "submit", {"values": fill(rt.forms[2])}, facts)
        self.assertEqual(state["completed"], [1, 2])
        state, _ = rt.act(state, SUP, "send_back", {"reason": "negative DDR", "to_stage": 1}, facts)  # G-B loop
        self.assertEqual((state["stage"], state["completed"], state["reached"]), (1, [], []))

    def test_admin_override_and_separation_of_duties(self):
        rt = self.rts["pex"]   # stage 1: executive -> supervisor (admin is NOT in the chain)
        facts = {"reached": {"design": ["approved"]}}
        state, _ = rt.new_case("c-pex", SITE, facts)
        state, ev = rt.act(state, ADMIN, "submit", {"values": fill(rt.forms[1])}, facts)  # guard bypass
        self.assertTrue(ev[0]["override"])
        self.assertEqual(rt.next_step(state)["role"], "supervisor")      # override never self-approves
        with self.assertRaises(Refusal) as e:
            rt.act(state, ADMIN, "approve", {}, facts)
        self.assertEqual(e.exception.code, "separation_of_duties")
        state, ev = rt.act(state, SUP, "approve", {}, facts)
        self.assertEqual((state["stage"], ev[0]["override"]), (2, False))

    def test_supervisor_self_upload_auto_approves(self):
        rt = self.rts["pex"]  # stage 1: executive -> supervisor; the supervisor uploads the budget itself
        facts = {"reached": {"design": ["approved"]}}
        state, _ = rt.new_case("c-pex2", SITE, facts)
        state, ev = rt.act(state, SUP, "submit", {"values": fill(rt.forms[1])}, facts)
        self.assertEqual([e["type"] for e in ev], ["submitted", "auto_approved", "stage_completed"])
        self.assertFalse(any(e["override"] for e in ev))
        self.assertEqual(state["stage"], 2)
        with self.assertRaises(Refusal) as e:   # an executive cannot do the supervisor's review
            rt.act(state, EXEC, "approve", {}, facts)
        self.assertEqual(e.exception.code, "wrong_tier")

    def test_version_pinning(self):
        rt1 = self.rts["bd"]
        state, _ = rt1.new_case("c-bd", SITE)
        m2 = copy.deepcopy(next(m for m in self.mods if m["key"] == "bd"))
        m2["stages"] = m2["stages"][:2]
        rt2 = ModuleRuntime(m2, "v2")
        with self.assertRaises(Refusal) as e:
            rt2.act(state, EXEC, "submit", {"values": {}})
        self.assertEqual(e.exception.code, "release_mismatch")
        state, _ = drive(rt1, state)
        self.assertEqual((state["status"], state["release"], len(state["completed"])), ("completed", "v1", 4))

    def test_audit_chain_detects_tampering(self):
        rt = self.rts["bd"]
        state, events = rt.new_case("c-audit", SITE)
        state, events = drive(rt, state, None, events)
        self.assertTrue(verify_chain(events))
        forged = copy.deepcopy(events)
        forged[2]["actor"] = "someone-else"
        self.assertFalse(verify_chain(forged))
        self.assertFalse(verify_chain(events[:2] + events[3:]))


@unittest.skipUnless(HAVE_JSONSCHEMA, "pip install jsonschema==4.26.0")
class F2SchemaAlignment(unittest.TestCase):
    """Rows produced for F2's proposed module_records / module_approvals satisfy their CHECK vocabularies."""

    def test_rows_fit_f2_checks(self):
        rows, approvals = [], []
        for m in flow()["modules"]:
            rt = ModuleRuntime(m, "v1")
            src = {c["source"]: ["done", "approved"] for c in (m.get("entry_gate") or {}).get("conditions", [])}
            state, events = rt.new_case("c", SITE, {"reached": src})
            rows.append(module_record_row(state, m.get("exit_signal")))
            state, events = drive(rt, state, {"reached": src, "stages": {}}, events)
            rows.append(module_record_row(state, m.get("exit_signal")))
            approvals += [a for a in map(approval_row, events) if a]
        self.assertTrue(all(r["status"] in F2_OUTCOMES for r in rows))
        self.assertTrue(all((r["exit_outcome"] is None) or r["exit_outcome"] in F2_OUTCOMES for r in rows))
        self.assertTrue(all(a["verdict"] in F2_VERDICTS for a in approvals))
        self.assertTrue(all(a["tier"] in ("executive", "supervisor", "business_admin") for a in approvals))
        # F2 guard: a 'submitted' verdict must come from an executive or supervisor actor
        self.assertTrue(all(a["actor_role"] in ("executive", "supervisor") for a in approvals if a["verdict"] == "submitted"))
        print(f"\n  F2 alignment: {len(rows)} module_records rows, {len(approvals)} module_approvals rows fit the CHECKs")

    def test_admin_override_submission_conflicts_with_f2_guard(self):
        # documented conflict: production lets a business admin act anywhere; F2's guard refuses an admin 'submitted'
        rt = ModuleRuntime(next(m for m in flow()["modules"] if m["key"] == "pex"), "v1")
        facts = {"reached": {"design": ["approved"]}}
        state, _ = rt.new_case("c", SITE, facts)
        _, ev = rt.act(state, ADMIN, "submit", {"values": fill(rt.forms[1])}, facts)
        row = approval_row(ev[0])
        self.assertEqual((row["verdict"], row["actor_role"]), ("submitted", "business_admin"))


@unittest.skipUnless(HAVE_JSONSCHEMA, "pip install jsonschema==4.26.0")
class Extensions(unittest.TestCase):
    """Capabilities v5 cannot express yet, shown working in the runtime (manifest extensions)."""

    def test_stage_level_gate(self):
        nso = copy.deepcopy(next(m for m in flow()["modules"] if m["key"] == "nso"))
        nso["stages"][1]["gate"] = {"match": "all", "conditions": [{"source": "project", "stage": 1}],
                                    "refusal_message": "Stage 2 waits for Project initialization."}
        rt = ModuleRuntime(nso, "v1")
        facts = {"reached": {"finance_ca": ["approved"]}, "stages": {}}
        state, _ = rt.new_case("c-nso", SITE, facts)
        state, _ = rt.act(state, SUP, "submit", {"values": fill(rt.forms[1])}, facts)
        with self.assertRaises(Refusal) as e:
            rt.act(state, SUP, "submit", {"values": fill(rt.forms[2])}, facts)
        self.assertEqual((e.exception.code, e.exception.message), ("stage_gate_closed", "Stage 2 waits for Project initialization."))
        facts["stages"] = {"project": [1]}
        state, _ = rt.act(state, SUP, "submit", {"values": fill(rt.forms[2])}, facts)
        self.assertEqual(state["stage"], 3)

    def test_forward_only_launch_loop(self):
        la = copy.deepcopy(next(m for m in flow()["modules"] if m["key"] == "launch_approval"))
        la["stages"][1]["approvers"] = ["business_admin", "executive"]  # admin review -> creator verdict
        la["stages"][1]["forward_only"] = True
        rt = ModuleRuntime(la, "v1")
        facts = {"reached": {"nso": ["done"]}}
        state, _ = rt.new_case("c-la", SITE, facts)
        state, _ = rt.act(state, ADMIN, "submit", {"values": fill(rt.forms[1])}, facts)
        state, _ = rt.act(state, EXEC, "submit", {"values": fill(rt.forms[2])}, facts)
        state, ev = rt.act(state, ADMIN, "reject", {"reason": "creator disagrees"}, facts)
        self.assertEqual(state["status"], "in_progress")   # recorded, never bounces
        self.assertEqual(state["verdicts"][0]["verdict"], "negative")
        state, _ = drive(rt, state, facts)
        self.assertEqual(state["status"], "completed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
