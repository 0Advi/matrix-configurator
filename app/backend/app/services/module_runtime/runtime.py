"""Reference interpreter for custom modules ("runtime": "generic") — pure Python, no DB, no framework.

First-party glue: the recommended custom-module runtime for D4 (see docs/oss/for-F4.md). F4 wraps it
in FastAPI routes and persists ``state`` (one JSON row per case = site x module) and ``events``
(append-only, hash-chained). It interprets a PUBLISHED, IMMUTABLE manifest module:

* entry gate (all/any) + optional stage-level gates  -> gates.py (JsonLogic, same rules as the frontend)
* stages in order; each stage's ``approvers`` form a tier chain executive < supervisor < business_admin.
  The first step submits the stage form (validated with forms.py / jsonschema), later steps approve,
  send back (to the previous step, or to an earlier stage = loop, G-B) or reject.
* ``forward_only`` stages record a negative verdict and move on (G-C, the Launch loop).
* tiers: business_admin_signoff=False drops admin steps; delegation=True requires an executive to hold
  a delegation for the site; observers never write; business_admin may act on any step (production's
  guard bypass) — flagged ``override`` in the audit event; separation of duties within one stage pass.
* a stage approver may perform an earlier step of that stage; the following steps of their own role then
  collapse ("supervisor's self-upload auto-approves"). An admin override from outside the chain never collapses.
* roll-up fields may carry ``outcome_map`` (extension) to score options such as positive/negative (G-E).
* version pinning: a case records the release it started on; a runtime built for another release refuses.
* G3 creator rule: a stage with ``restricted_to: "site_creator"`` gives its FIRST step (the chain head,
  normally the executive step) to the site's creator only — ``Actor.owned_sites`` = sites the actor
  submitted or is assigned to (the real app's owns()). Executives and supervisors who do not own the
  site are refused (``not_site_creator``); the owner needs no delegation for that step; a business
  admin who does not own it acts only as a flagged override. Events of that step carry
  ``restricted_to`` and ``site_creator`` (did the actor own the site) in their payload.
* module verdict at the end: rejected if a tier rejected (non forward-only); else the roll-up over
  outcome-affecting yes/no fields; with no such fields the sign-off itself approves (INFERRED — v5 only
  describes roll-ups). Then ``exit_signal`` joins the module's reached outcomes for downstream gates.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

# F4a: package-relative imports (third_party/matrix-adapters used top-level modules).
from . import forms, gates

TIER_RANK = {"executive": 0, "supervisor": 1, "business_admin": 2}
ROLLUP_KINDS = ("choice", "yesno")


class Refusal(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass(frozen=True)
class Actor:
    id: str
    role: str  # executive | supervisor | business_admin | observer
    delegated_sites: Tuple[str, ...] = field(default_factory=tuple)
    # G3: sites this actor created (sites.submitted_by) or is the BD assignee of (sites.assigned_to)
    owned_sites: Tuple[str, ...] = field(default_factory=tuple)


CREATOR_RULE = "site_creator"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _canon(x: Any) -> str:
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalize_module(m: Dict[str, Any]) -> Dict[str, Any]:
    """Accept a workspace-manifest module or a wizard ``moduleDraftManifest`` ({module:{...}, tiers, ...})."""
    if "module" in m and isinstance(m["module"], dict):
        head = m["module"]
        m = dict(m, key=head["key"], name=head["name"], type=head.get("type", "custom"))
    return m


class ModuleRuntime:
    def __init__(self, module: Dict[str, Any], release: str, *, admin_override: bool = True,
                 separation_of_duties: bool = True, clock: Callable[[], str] = _now):
        self.m = normalize_module(module)
        self.key, self.release, self.clock = self.m["key"], release, clock
        self.admin_override, self.sod = admin_override, separation_of_duties
        self.tiers = self.m.get("tiers") or {}
        self.stages = sorted(self.m["stages"], key=lambda s: s["order"])
        self.forms = {s["order"]: forms.stage_form(s, file_mode="ref") for s in self.stages}
        self.entry_rule = gates.compile_gate(self.m.get("entry_gate"))
        self.rollup_rule = gates.compile_rollup(self.m.get("rollup"))

    # ------------------------------------------------------------------ structure
    def chain(self, stage: Dict[str, Any]) -> List[str]:
        roles = sorted(set(stage.get("approvers") or ["supervisor"]), key=lambda r: TIER_RANK.get(r, 1))
        if self.tiers.get("business_admin_signoff") is False:
            roles = [r for r in roles if r != "business_admin"] or ["supervisor"]
        if self.tiers.get("executive") is False:
            roles = [r for r in roles if r != "executive"] or ["supervisor"]
        return roles

    def _stage(self, order: int) -> Dict[str, Any]:
        return next(s for s in self.stages if s["order"] == order)

    def creator_step(self, state: Dict[str, Any]) -> bool:
        """G3: is the case's current step the FIRST step of a ``restricted_to: site_creator`` stage?"""
        st = self._stage(state["stage"])
        return st.get("restricted_to") == CREATOR_RULE and state["step"] == 0

    # ------------------------------------------------------------------ case lifecycle
    def new_case(self, case_id: str, site_id: str, facts: Optional[Dict[str, Any]] = None):
        state = {"case": case_id, "site": site_id, "module": self.key, "release": self.release,
                 "status": "locked", "stage": self.stages[0]["order"], "step": 0, "pass": [],
                 "completed": [], "values": {}, "verdicts": [], "verdict": None, "reached": [],
                 "seq": 0, "last_hash": None}
        state, ev = self._emit(state, "case_created", None, {"release": self.release})
        events = [ev]
        state, more = self.refresh(state, facts or {})
        return state, events + more

    def refresh(self, state: Dict[str, Any], facts: Dict[str, Any]):
        """Re-evaluate the entry gate (call when an upstream module changes)."""
        if state["status"] != "locked":
            return state, []
        is_open, refusal, unmet = gates.check_gate(self.m.get("entry_gate"), facts)
        if not is_open:
            return state, []
        state = dict(state, status="open")
        state, ev = self._emit(state, "gate_opened", None, {"unmet": unmet})
        return state, [ev]

    def gate_status(self, facts: Dict[str, Any]) -> Dict[str, Any]:
        is_open, refusal, unmet = gates.check_gate(self.m.get("entry_gate"), facts)
        return {"open": is_open, "refusal": refusal, "unmet": unmet}

    def next_step(self, state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if state["status"] in ("locked", "completed", "rejected", "parked"):
            return None
        st = self._stage(state["stage"])
        submit = state["step"] == 0 and bool(st.get("fields"))  # a field-less first step is a pure decision
        out = {"stage": st["order"], "name": st["name"], "role": self.chain(st)[state["step"]],
               "kind": "submit" if submit else "approve",
               "form": self.forms[st["order"]] if submit else None}
        if self.creator_step(state):
            out["restricted_to"] = CREATOR_RULE
        return out

    # ------------------------------------------------------------------ authorization
    def _authorize(self, state: Dict[str, Any], actor: Actor, role: str) -> bool:
        """-> override flag (business_admin acting outside the chain). Raises Refusal."""
        if actor.role == "observer":
            raise Refusal("observer_read_only", "Observers can view but never act.")
        creator_step = self.creator_step(state)
        if creator_step and state["site"] not in actor.owned_sites:
            # G3: only the site's creator; a business admin may still act, recorded as an override.
            if actor.role == "business_admin" and self.admin_override:
                if self.sod and any(p["actor"] == actor.id and p["role"] != role for p in state["pass"]):
                    raise Refusal("separation_of_duties", "You already acted on another tier of this stage.")
                return True
            raise Refusal("not_site_creator", "Only the site's creator can do this step.")
        if not creator_step and role == "executive" and actor.role == "executive" and self.tiers.get("delegation") \
                and state["site"] not in actor.delegated_sites:
            raise Refusal("no_delegation", "This site is not delegated to you.")
        if self.sod and any(p["actor"] == actor.id and p["role"] != role for p in state["pass"]):
            raise Refusal("separation_of_duties", "You already acted on another tier of this stage.")
        if actor.role == role:
            return False
        chain = self.chain(self._stage(state["stage"]))
        if actor.role in chain and TIER_RANK.get(actor.role, -1) > TIER_RANK.get(role, 99):
            return False  # a stage approver may do an earlier step of the same stage (production: self-upload)
        if actor.role == "business_admin" and self.admin_override:
            return True
        raise Refusal("wrong_tier", f"This step needs a {role.replace('_', ' ')}.")

    def actions(self, state: Dict[str, Any], actor: Actor) -> List[str]:
        nxt = self.next_step(state)
        if not nxt:
            return []
        try:
            self._authorize(state, actor, nxt["role"])
        except Refusal:
            return []
        if nxt["kind"] == "submit":
            return ["submit"] + (["send_back"] if state["completed"] else [])
        can_send_back = state["step"] > 0 or bool(state["completed"])
        return ["approve"] + (["send_back"] if can_send_back else []) + ["reject"]

    # ------------------------------------------------------------------ transitions
    def act(self, state: Dict[str, Any], actor: Actor, action: str, payload: Optional[Dict[str, Any]] = None,
            facts: Optional[Dict[str, Any]] = None):
        """-> (new_state, [events]). Raises Refusal; never mutates ``state``."""
        payload, facts = payload or {}, facts or {}
        if state["release"] != self.release:
            raise Refusal("release_mismatch", f"Case is pinned to {state['release']}; load that release.")
        if state["status"] == "locked":
            raise Refusal("gate_closed", self.gate_status(facts)["refusal"] or "Locked.")
        nxt = self.next_step(state)
        if not nxt:
            raise Refusal("closed", "This case is finished.")
        override = self._authorize(state, actor, nxt["role"])
        st = self._stage(state["stage"])
        s = copy.deepcopy(state)
        if s["status"] == "open":
            s["status"] = "in_progress"
        creator_step = self.creator_step(state)
        ev_payload: Dict[str, Any] = {"stage": st["order"], "step": s["step"], "role": nxt["role"],
                                      "acting_as_delegate": actor.role == "executive" and bool(self.tiers.get("delegation"))
                                      and not creator_step}
        if creator_step:
            ev_payload["restricted_to"] = CREATOR_RULE
            ev_payload["site_creator"] = state["site"] in actor.owned_sites

        if action == "submit":
            if nxt["kind"] != "submit":
                raise Refusal("wrong_action", "This step is a review; approve, send back or reject.")
            if st.get("gate"):
                ok, refusal, _ = gates.check_gate(st["gate"], facts)
                if not ok:
                    raise Refusal("stage_gate_closed", refusal)
            values = payload.get("values", {})
            errors = forms.validate_submission(self.forms[st["order"]]["schema"], values)
            if errors:
                raise Refusal("invalid_form", "; ".join(errors))
            s["values"][str(st["order"])] = values
            ev_payload["values"] = values
            return self._advance(s, actor, nxt["role"], "submitted", ev_payload, override)
        if action == "approve":
            if nxt["kind"] != "approve":
                raise Refusal("wrong_action", "Submit the stage first.")
            if st.get("gate") and s["step"] == 0:
                ok, refusal, _ = gates.check_gate(st["gate"], facts)
                if not ok:
                    raise Refusal("stage_gate_closed", refusal)
            return self._advance(s, actor, nxt["role"], "approved", ev_payload, override)
        reason = (payload.get("reason") or "").strip()
        if action in ("send_back", "reject") and not reason:
            raise Refusal("reason_required", "A reason is required.")
        ev_payload["reason"] = reason
        if action == "reject":
            if nxt["kind"] != "approve":
                raise Refusal("wrong_action", "Nothing to reject yet; submit the stage first.")
            s["verdicts"].append({"stage": st["order"], "role": nxt["role"], "verdict": "negative", "reason": reason})
            if st.get("forward_only"):
                ev_payload["forward_only"] = True
                return self._advance(s, actor, nxt["role"], "rejected_forward", ev_payload, override)
            s["status"], s["verdict"] = "rejected", "rejected"
            s["pass"] = []
            s, ev = self._emit(s, "rejected", actor, ev_payload, override)
            return s, [ev]
        if action == "send_back":
            target = payload.get("to_stage")
            to = None
            if target is None:
                if s["step"] > 0:
                    s["step"] -= 1  # back one tier inside the stage
                    s["pass"] = s["pass"][:-1]
                elif s["completed"]:
                    to = s["completed"][-1]
                else:
                    raise Refusal("nothing_to_send_back", "There is no earlier stage to send back to.")
            else:
                if not isinstance(target, int) or target > s["stage"] or target not in [x["order"] for x in self.stages]:
                    raise Refusal("bad_target", "Send back only to this stage or an earlier one.")
                to = target  # a loop (G-B): e.g. negative DDR -> back to stage 1
            if to is not None:
                s["completed"] = [o for o in s["completed"] if o < to]
                s["stage"], s["step"], s["pass"] = to, 0, []
            s["reached"] = self._reached(s)
            ev_payload["to"] = {"stage": s["stage"], "step": s["step"]}
            s, ev = self._emit(s, "sent_back", actor, ev_payload, override)
            return s, [ev]
        raise Refusal("unknown_action", f"Unknown action {action!r}.")

    def _advance(self, s, actor: Actor, role: str, kind: str, ev_payload, override: bool):
        events = []
        s["pass"].append({"actor": actor.id, "role": role})
        s, ev = self._emit(s, kind, actor, ev_payload, override)
        events.append(ev)
        st = self._stage(s["stage"])
        chain = self.chain(st)
        s["step"] += 1
        # collapse following steps of the actor's own role (production: a supervisor's own upload auto-approves);
        # never when acting through the admin override, or an admin could sign off their own submission
        while not override and s["step"] < len(chain) and chain[s["step"]] == actor.role:
            s["pass"].append({"actor": actor.id, "role": chain[s["step"]]})
            s, ev = self._emit(s, "auto_approved", actor, {"stage": st["order"], "step": s["step"],
                                                           "role": chain[s["step"]], "why": "self-approval"}, override)
            events.append(ev)
            s["step"] += 1
        if s["step"] < len(chain):
            return s, events
        # stage complete
        s["completed"].append(st["order"])
        s["pass"], s["step"] = [], 0
        s["reached"] = self._reached(s)
        s, ev = self._emit(s, "stage_completed", actor, {"stage": st["order"], "outcome": st["outcome"]}, override)
        events.append(ev)
        later = [x for x in self.stages if x["order"] > st["order"]]
        if later and not st.get("terminal"):
            s["stage"] = later[0]["order"]
            return s, events
        s["verdict"] = self._verdict(s)
        # pending / pending_engineering = roll-up unresolved: park the case (no exit signal, nothing downstream opens)
        s["status"] = {"rejected": "rejected", "approved": "completed", "done": "completed"}.get(s["verdict"], "parked")
        s["reached"] = self._reached(s)
        s, ev = self._emit(s, "module_completed", actor, {"verdict": s["verdict"], "reached": s["reached"]}, override)
        events.append(ev)
        return s, events

    # ------------------------------------------------------------------ outcomes
    def rollup_inputs(self, s) -> Tuple[List[str], List[str]]:
        checks, ignored = [], []
        for st in self.stages:
            vals = s["values"].get(str(st["order"]), {})
            for f in st.get("fields", []):
                if not f.get("affects_outcome"):
                    continue
                if f["kind"] not in ROLLUP_KINDS:
                    ignored.append(f["key"])
                    continue
                v = vals.get(f["key"])
                v = (f.get("outcome_map") or {}).get(v, v)  # extension: map options like "positive" -> "yes" (G-E)
                checks.append("yes" if v is True else "no" if v is False else "" if v is None else str(v))
        return checks, ignored

    def _verdict(self, s) -> str:
        if self.rollup_rule == "pending_engineering":
            return "pending_engineering"
        checks, _ = self.rollup_inputs(s)
        if not checks:
            return "approved"
        return gates.rollup_verdict(self.m.get("rollup"), checks)

    def _reached(self, s) -> List[str]:
        out: List[str] = []
        for o in s["completed"]:
            oc = self._stage(o)["outcome"]
            if oc not in out:
                out.append(oc)
        exit_sig = self.m.get("exit_signal")
        if s.get("status") == "completed" and s.get("verdict") in ("approved", "done") and exit_sig and exit_sig not in out:
            out.append(exit_sig)
        return out

    def contribution(self, s) -> Dict[str, Any]:
        """This case's share of the site facts that gates read."""
        merged: Dict[str, Any] = {}
        for vals in s["values"].values():
            merged.update(vals)
        return {"reached": list(s["reached"]), "stages": list(s["completed"]), "fields": merged}

    # ------------------------------------------------------------------ audit
    def _emit(self, s, kind: str, actor: Optional[Actor], payload, override: bool = False):
        s = dict(s, seq=s["seq"] + 1)
        body = {"case": s["case"], "site": s["site"], "module": self.key, "release": self.release, "seq": s["seq"],
                "type": kind, "actor": actor.id if actor else "system", "actor_role": actor.role if actor else "system",
                "override": bool(override), "payload": payload, "at": self.clock(), "prev": s["last_hash"]}
        body["hash"] = hashlib.sha256(_canon(body).encode()).hexdigest()
        s["last_hash"] = body["hash"]
        return s, body


def site_facts(cases: List[Tuple[str, Dict[str, Any], "ModuleRuntime"]]) -> Dict[str, Any]:
    """[(module_key, state, runtime)] for ONE site -> the facts object gates evaluate."""
    facts: Dict[str, Any] = {"reached": {}, "stages": {}, "fields": {}}
    for key, state, rt in cases:
        c = rt.contribution(state)
        facts["reached"][key], facts["stages"][key], facts["fields"][key] = c["reached"], c["stages"], c["fields"]
    return facts


def verify_chain(events: List[Dict[str, Any]]) -> bool:
    prev = None
    for e in events:
        body = {k: v for k, v in e.items() if k != "hash"}
        if body["prev"] != prev or hashlib.sha256(_canon(body).encode()).hexdigest() != e["hash"]:
            return False
        prev = e["hash"]
    return True


# ---------------------------------------------------------------------------------------------
# Mapping onto F2's proposed tables (docs/schema-audit/proposed-migrations/20261004_5_generic_module_runtime.sql)
# Their CHECKs use the configurator outcome vocabulary; these helpers keep the runtime's richer
# states inside it. audit_logs (20261004_6: config_release_id, module_key, provenance) gets EVERY event.
F2_OUTCOMES = ("pending", "allocated", "in progress", "submitted", "rejected", "approved", "done", "skipped")
F2_VERDICTS = ("submitted", "approved", "rejected", "sent_back")
_EVENT_TO_VERDICT = {"submitted": "submitted", "approved": "approved", "auto_approved": "approved",
                     "rejected": "rejected", "rejected_forward": "rejected", "sent_back": "sent_back"}


def module_record_row(state: Dict[str, Any], exit_signal: Optional[str]) -> Dict[str, Any]:
    """state -> module_records columns (status / current_stage / exit_outcome)."""
    st = state["status"]
    status = {"locked": "pending", "open": "pending", "in_progress": "in progress", "rejected": "rejected",
              "parked": "submitted"}.get(st)
    if st == "completed":
        status = exit_signal if exit_signal in F2_OUTCOMES else "approved"
    closed = st in ("completed", "rejected")
    return {"status": status, "current_stage": None if closed else state["stage"],
            "exit_outcome": status if closed else None}


def approval_row(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """event -> module_approvals columns, or None for events that only go to audit_logs."""
    verdict = _EVENT_TO_VERDICT.get(event["type"])
    if verdict is None:
        return None
    p = event["payload"]
    comment = p.get("reason") or ("self-approval" if event["type"] == "auto_approved" else None)
    if event["type"] == "rejected_forward":
        comment = f"[forward-only] {comment or ''}".strip()
    if verdict == "submitted" and p["role"] == "business_admin":
        # an admin-only stage with fields (Design GFC, PEx admin review, Launch admin review): the form IS the
        # sign-off. F2's guard only accepts 'submitted' from executive/supervisor, so record it as 'approved'.
        verdict, comment = "approved", comment or "sign-off with form"
    return {"stage_order": p["stage"], "tier": p["role"], "actor_id": event["actor"],
            "actor_role": event["actor_role"], "acting_as_delegate": bool(p.get("acting_as_delegate")),
            "verdict": verdict, "comment": comment, "release": event["release"]}
