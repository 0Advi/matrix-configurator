"""Validator for ``workspace-manifest/1``.

``validate(manifest, adapters=None)`` is pure (no I/O beyond loading the schema once) and returns::

    {"ok": bool, "errors": int, "warnings": int, "findings": [Finding, ...]}

Finding = ``{"severity": "error"|"warning", "rule": "R1".."R10", "code": str, "message": str,
            "path": str, "module"?: str, "stage"?: str, "field"?: str}``.

A manifest with any ``error`` must not be published. Rules (each has at least one failing fixture
in ``tests/fixtures``):

R1  unique keys        — subjects, roles, outcomes, signals, modules (modules and signals share one
                         namespace: gates name either), stages per module, fields per stage/subject,
                         options per field, views per module; reserved module keys.
R2  no unknown refs    — every role, outcome, subject, module, stage and field a manifest names exists;
                         module ``members`` are module-scope roles.
R3  valid actors       — every stage has at least one valid submitter; every actor (submit role,
                         approval tier) is known, not read-only, and either a member role of the
                         module or a workspace-scope role.
R4  gates              — sources exist; no entry gate waits on its own module; stage/field references
                         exist; a stage gate never waits on its own stage or a later stage.
R5  no dead gates      — a gate is dead when it can never open: its source is disabled, on another
                         subject, can never reach the outcome, is itself unreachable (dependency
                         chain), or the gates form a cycle. Computed as a liveness fixed point.
R6  no unreachable     — every outcome a gate or view waits on can be produced by its source;
    outcomes             exits are final outcomes; an ``on_reject`` that no step can trigger is flagged.
R7  no built-in        — no built-in module type, implementation string or route override; any
    behaviour            adapter is registered and only declares hooks the adapter implements.
R8  fields             — option/validation consistency (min <= max, valid regex, currency for money,
                         choice options unique, person role exists).
R9  roll-up & views    — roll-up field references exist and are scorable; view stages/outcomes exist;
                         ``default_for`` is a subset of ``audience``.
R10 grants             — read-only roles never hold a write grant; someone can publish.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Set

FORMAT = "workspace-manifest/1"
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "workspace_manifest.schema.json")

RESERVED_MODULE_KEYS = frozenset({"admin", "api", "auth", "me", "m", "new", "platform", "settings", "workspace", "workspaces"})
FINAL_KINDS = frozenset({"positive", "negative", "neutral"})
WRITE_GRANTS = frozenset({"publish_release", "edit_draft", "migrate_cases", "manage_members", "manage_views",
                          "assign_cases", "override_step", "manage_workspace"})
SCORABLE_TYPES = frozenset({"choice", "yes_no", "number", "money"})
# Built-in-only hints that must never appear on a module (R7): they are how the old v5 manifest and the
# app's module_catalog smuggled bespoke code paths in.
BUILTIN_MARKERS = ("type", "implementation", "route", "builtin", "status_source", "outcome_map", "reached_map")


@lru_cache(maxsize=1)
def _schema_validator():
    import jsonschema

    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return jsonschema.Draft202012Validator(json.load(fh))


class _Report:
    def __init__(self) -> None:
        self.findings: List[Dict[str, Any]] = []

    def add(self, severity: str, rule: str, code: str, message: str, path: str, **where: Any) -> None:
        self.findings.append({"severity": severity, "rule": rule, "code": code, "message": message, "path": path,
                              **{k: v for k, v in where.items() if v is not None}})

    def error(self, rule, code, message, path, **where):
        self.add("error", rule, code, message, path, **where)

    def warn(self, rule, code, message, path, **where):
        self.add("warning", rule, code, message, path, **where)

    def result(self) -> Dict[str, Any]:
        errors = sum(1 for f in self.findings if f["severity"] == "error")
        return {"ok": errors == 0, "errors": errors, "warnings": len(self.findings) - errors, "findings": self.findings}


def _dups(values: Iterable[Any]) -> List[Any]:
    seen, out = set(), []
    for v in values:
        if v in seen and v not in out:
            out.append(v)
        seen.add(v)
    return out


def _list(x: Any) -> List[Any]:
    return x if isinstance(x, list) else []


def _dicts(x: Any) -> List[Dict[str, Any]]:
    return [i for i in _list(x) if isinstance(i, dict)]


def validate(manifest: Any, adapters: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Validate a manifest.

    ``adapters``: the adapter registry of the target platform, ``{key: {"versions": [...], "hooks": [...]}}``.
    ``None`` = registry unknown (a declared adapter is then only a warning); ``{}`` = no adapters installed.
    """
    r = _Report()
    if not isinstance(manifest, dict):
        r.error("R0", "schema", "manifest must be a JSON object", "")
        return r.result()

    # R7 first: give built-in markers a precise code instead of a generic schema error.
    for i, m in enumerate(_dicts(manifest.get("modules"))):
        for marker in BUILTIN_MARKERS:
            if marker in m:
                r.error("R7", "builtin_behavior",
                        f"module {m.get('key')!r} has {marker!r}: modules are defined only by stages, gates, fields, "
                        "roll-up and declared adapter hooks — there are no built-in modules",
                        f"modules/{i}/{marker}", module=m.get("key"))

    for e in sorted(_schema_validator().iter_errors(manifest), key=lambda e: list(map(str, e.absolute_path))):
        path = "/".join(map(str, e.absolute_path))
        if e.validator == "additionalProperties" and any(f"'{k}'" in e.message for k in BUILTIN_MARKERS) \
                and re.fullmatch(r"modules/\d+", path or ""):
            continue  # already reported as builtin_behavior
        r.error("R0", "schema", f"{path or '(manifest)'}: {e.message}", path)

    ctx = _Context(manifest)
    _r1_unique(r, ctx)
    _r2_refs(r, ctx)
    _r3_actors(r, ctx)
    _r4_r5_r6_gates(r, ctx)
    _r7_adapters(r, ctx, adapters)
    _r8_fields(r, ctx)
    _r9_rollup_views(r, ctx)
    _r10_grants(r, ctx)
    return r.result()


class _Context:
    """Indexes of the manifest, tolerant of a manifest that failed the schema."""

    def __init__(self, m: Dict[str, Any]) -> None:
        self.m = m
        self.subjects = _dicts(m.get("subjects"))
        self.roles = _dicts(m.get("roles"))
        self.outcomes = _dicts(m.get("outcomes"))
        self.signals = _dicts(m.get("signals"))
        self.modules = _dicts(m.get("modules"))
        self.grants = _dicts(m.get("permissions"))
        self.role = {x.get("key"): x for x in self.roles}
        self.outcome = {x.get("key"): x for x in self.outcomes}
        self.subject = {x.get("key"): x for x in self.subjects}
        self.signal = {x.get("key"): x for x in self.signals}
        self.module = {x.get("key"): x for x in self.modules}
        self.workspace_currency = (m.get("workspace") or {}).get("currency") if isinstance(m.get("workspace"), dict) else None

    def stages(self, mod: Dict[str, Any]) -> List[Dict[str, Any]]:
        return _dicts(mod.get("stages"))

    def stage_index(self, mod: Dict[str, Any]) -> Dict[str, int]:
        return {s.get("key"): i for i, s in enumerate(self.stages(mod))}

    def field_map(self, mod: Dict[str, Any]) -> Dict[str, Dict[str, Dict[str, Any]]]:
        return {s.get("key"): {f.get("key"): f for f in _dicts(s.get("fields"))} for s in self.stages(mod)}

    def can_reject(self, mod: Dict[str, Any]) -> bool:
        return any("reject" in _list(a.get("actions", ["approve", "reject", "send_back"]))
                   for s in self.stages(mod) for a in _dicts(s.get("approvals")))

    def reachable_outcomes(self, key: str) -> Set[str]:
        """Every outcome module/signal ``key`` can ever report as reached."""
        if key in self.signal:
            return set(_list(self.signal[key].get("outcomes")))
        mod = self.module.get(key)
        if not mod:
            return set()
        out = {s.get("outcome") for s in self.stages(mod) if isinstance(s.get("outcome"), str)}
        ex = mod.get("exit") if isinstance(mod.get("exit"), dict) else {}
        if ex.get("on_complete"):
            out.add(ex["on_complete"])
        rejectable = self.can_reject(mod)
        if ex.get("on_reject") and rejectable:
            out.add(ex["on_reject"])
        ru = mod.get("rollup") if isinstance(mod.get("rollup"), dict) else {}
        if ru.get("strategy") not in (None, "none"):
            for k in ("positive", "negative"):
                if ru.get(k):
                    out.add(ru[k])
        return out


# ── R1 ────────────────────────────────────────────────────────────────────────────────────────────
def _r1_unique(r: _Report, c: _Context) -> None:
    for name, items in (("subject", c.subjects), ("role", c.roles), ("outcome", c.outcomes), ("signal", c.signals)):
        for d in _dups(x.get("key") for x in items):
            r.error("R1", "duplicate_key", f"{name} key {d!r} is declared more than once", f"{name}s", key=d)
    for d in _dups(x.get("key") for x in c.modules):
        r.error("R1", "duplicate_module_key", f"module key {d!r} appears more than once", "modules", module=d)
    for k in set(c.module) & set(c.signal):
        r.error("R1", "duplicate_module_key", f"{k!r} is both a module and a signal; gates could not tell them apart",
                "modules", module=k)
    for i, mod in enumerate(c.modules):
        mk = mod.get("key")
        if mk in RESERVED_MODULE_KEYS:
            r.error("R1", "reserved_key", f"module key {mk!r} is reserved by the platform", f"modules/{i}/key", module=mk)
        for d in _dups(s.get("key") for s in c.stages(mod)):
            r.error("R1", "duplicate_key", f"stage key {d!r} repeats in module {mk!r}", f"modules/{i}/stages", module=mk, stage=d)
        for d in _dups(v.get("key") for v in _dicts(mod.get("views"))):
            r.error("R1", "duplicate_key", f"view key {d!r} repeats in module {mk!r}", f"modules/{i}/views", module=mk)
        for j, s in enumerate(c.stages(mod)):
            _unique_fields(r, _dicts(s.get("fields")), f"modules/{i}/stages/{j}/fields", module=mk, stage=s.get("key"))
    for i, sub in enumerate(c.subjects):
        _unique_fields(r, _dicts(sub.get("fields")), f"subjects/{i}/fields")


def _unique_fields(r: _Report, fields: List[Dict[str, Any]], path: str, **where: Any) -> None:
    for d in _dups(f.get("key") for f in fields):
        r.error("R1", "duplicate_key", f"field key {d!r} repeats", path, field=d, **where)
    for k, f in enumerate(fields):
        for d in _dups(o.get("value") for o in _dicts(f.get("options"))):
            r.error("R1", "duplicate_key", f"option {d!r} repeats in field {f.get('key')!r}", f"{path}/{k}/options",
                    field=f.get("key"), **where)


# ── R2 ────────────────────────────────────────────────────────────────────────────────────────────
def _role_ref(r: _Report, c: _Context, role: Any, path: str, **where: Any) -> bool:
    if role not in c.role:
        r.error("R2", "unknown_role", f"role {role!r} is not declared in roles[]", path, **where)
        return False
    return True


def _outcome_ref(r: _Report, c: _Context, outcome: Any, path: str, **where: Any) -> bool:
    if outcome not in c.outcome:
        r.error("R2", "unknown_outcome", f"outcome {outcome!r} is not declared in outcomes[]", path, **where)
        return False
    return True


def _r2_refs(r: _Report, c: _Context) -> None:
    for i, sig in enumerate(c.signals):
        if sig.get("subject") not in c.subject:
            r.error("R2", "unknown_subject", f"signal {sig.get('key')!r} runs on unknown subject {sig.get('subject')!r}",
                    f"signals/{i}/subject")
    for i, mod in enumerate(c.modules):
        mk, p = mod.get("key"), f"modules/{i}"
        if mod.get("subject") not in c.subject:
            r.error("R2", "unknown_subject", f"module {mk!r} runs on unknown subject {mod.get('subject')!r}", f"{p}/subject", module=mk)
        for role in _list(mod.get("members")):
            if _role_ref(r, c, role, f"{p}/members", module=mk) and c.role[role].get("scope") != "module":
                r.error("R2", "role_scope", f"{role!r} is a workspace-scope role; members[] lists module-scope roles only",
                        f"{p}/members", module=mk)
        ex = mod.get("exit") if isinstance(mod.get("exit"), dict) else {}
        for k in ("on_complete", "on_reject"):
            if k in ex:
                _outcome_ref(r, c, ex[k], f"{p}/exit/{k}", module=mk)
        idx = c.stage_index(mod)
        for j, s in enumerate(c.stages(mod)):
            sp = f"{p}/stages/{j}"
            if "outcome" in s:
                _outcome_ref(r, c, s.get("outcome"), f"{sp}/outcome", module=mk, stage=s.get("key"))
            for t in _list(s.get("send_back_to")):
                if t not in idx:
                    r.error("R2", "unknown_stage", f"send_back_to names unknown stage {t!r}", f"{sp}/send_back_to", module=mk, stage=s.get("key"))
                elif idx[t] >= j:
                    r.error("R2", "bad_send_back", f"send_back_to {t!r} is not an earlier stage", f"{sp}/send_back_to", module=mk, stage=s.get("key"))
    for i, g in enumerate(c.grants):
        for role in _list(g.get("roles")):
            _role_ref(r, c, role, f"permissions/{i}/roles")
        for mk in _list(g.get("modules")):
            if mk not in c.module:
                r.error("R2", "unknown_module", f"grant {g.get('action')!r} names unknown module {mk!r}", f"permissions/{i}/modules")


# ── R3 ────────────────────────────────────────────────────────────────────────────────────────────
def _actor_ok(r: _Report, c: _Context, mod: Dict[str, Any], role: Any, path: str, what: str, **where: Any) -> bool:
    if not _role_ref(r, c, role, path, **where):
        return False
    rd = c.role[role]
    if rd.get("read_only"):
        r.error("R3", "invalid_actor", f"{what}: role {role!r} is read-only and can never act", path, **where)
        return False
    if rd.get("scope") == "module" and role not in _list(mod.get("members")):
        r.error("R3", "invalid_actor", f"{what}: role {role!r} is not a member role of module {mod.get('key')!r}", path, **where)
        return False
    return True


def _r3_actors(r: _Report, c: _Context) -> None:
    for i, mod in enumerate(c.modules):
        mk = mod.get("key")
        for j, s in enumerate(c.stages(mod)):
            sk, sp = s.get("key"), f"modules/{i}/stages/{j}"
            sub = s.get("submit") if isinstance(s.get("submit"), dict) else {}
            valid = [ro for ro in _list(sub.get("roles"))
                     if _actor_ok(r, c, mod, ro, f"{sp}/submit/roles", "submit", module=mk, stage=sk)]
            if not valid:
                r.error("R3", "stage_without_actor", f"stage {sk!r} has no valid submitter; no one could ever complete it",
                        f"{sp}/submit", module=mk, stage=sk)
            if sub.get("restricted_to") == "assignee" and not mod.get("delegation"):
                r.warn("R3", "assignee_without_delegation",
                       f"stage {sk!r} is restricted to the assignee but module {mk!r} has delegation off; "
                       "only cases the creator assigned at open time can progress", f"{sp}/submit/restricted_to", module=mk, stage=sk)
            for k, a in enumerate(_dicts(s.get("approvals"))):
                _actor_ok(r, c, mod, a.get("role"), f"{sp}/approvals/{k}/role", f"approval tier {k + 1}", module=mk, stage=sk)
            tiers = [a.get("role") for a in _dicts(s.get("approvals"))]
            if mod.get("separation_of_duties", True) and len(tiers) == 1 and _list(sub.get("roles")) == tiers:
                r.warn("R3", "separation_of_duties_conflict",
                       f"stage {sk!r}: the only submitter role is also the only approver role; with separation of "
                       "duties on, two different people holding it are required", sp, module=mk, stage=sk)


# ── R4 / R5 / R6 ──────────────────────────────────────────────────────────────────────────────────
def _conditions(gate: Any) -> List[Dict[str, Any]]:
    return _dicts(gate.get("conditions")) if isinstance(gate, dict) else []


def _cond_possible(r: Optional[_Report], c: _Context, mod: Dict[str, Any], cond: Dict[str, Any], path: str,
                   live: Set[str], *, stage: Optional[str] = None, stage_pos: Optional[int] = None,
                   report: bool) -> bool:
    """Static check of one condition; returns False when it can never become true."""
    mk, src = mod.get("key"), cond.get("source")
    where = {"module": mk, "stage": stage}

    def err(rule, code, msg):
        if report:
            r.error(rule, code, msg, path, **where)

    if src not in c.module and src not in c.signal:
        err("R4", "gate_unknown_source", f"waits on {src!r}, which is not a module or signal of this workspace")
        return False
    if src == mk and stage_pos is None:
        err("R4", "gate_self_reference", "an entry gate cannot wait on its own module")
        return False
    src_subject = (c.module.get(src) or c.signal.get(src) or {}).get("subject")
    if src_subject != mod.get("subject"):
        err("R5", "dead_gate", f"waits on {src!r}, which runs on subject {src_subject!r}, not {mod.get('subject')!r}: "
                               "there is never a case of both for the same subject")
        return False
    if src in c.module and c.module[src].get("enabled", True) is False:
        err("R5", "dead_gate", f"waits on disabled module {src!r}; the gate can never open")
        return False
    if "outcome" in cond:
        if cond["outcome"] not in c.reachable_outcomes(src):
            if src in c.module and cond["outcome"] not in c.outcome:
                err("R2", "unknown_outcome", f"outcome {cond['outcome']!r} is not declared in outcomes[]")
            err("R6", "unreachable_outcome",
                f"{src!r} can never reach {cond['outcome']!r} (it can reach: {sorted(c.reachable_outcomes(src))})")
            return False
    if "stage" in cond:
        smod = c.module.get(src)
        if smod is None:
            err("R4", "gate_unknown_stage", f"{src!r} is a signal; signals have no stages")
            return False
        idx = c.stage_index(smod)
        if cond["stage"] not in idx:
            err("R4", "gate_unknown_stage", f"module {src!r} has no stage {cond['stage']!r}")
            return False
        if src == mk and stage_pos is not None and idx[cond["stage"]] >= stage_pos:
            err("R5", "dead_gate", f"stage gate waits on stage {cond['stage']!r} of its own module, which only runs at or after this stage")
            return False
        if "field" in cond:
            fmap = c.field_map(smod).get(cond["stage"], {})
            f = fmap.get(cond["field"])
            if f is None:
                err("R4", "gate_unknown_field", f"stage {cond['stage']!r} of {src!r} has no field {cond['field']!r}")
                return False
            if cond.get("op") in ("lt", "lte", "gt", "gte") and f.get("type") not in ("number", "money", "date"):
                err("R4", "gate_op_type", f"operator {cond['op']!r} needs a number/money/date field; {cond['field']!r} is {f.get('type')}")
                return False
            if f.get("type") in ("choice", "multi_choice"):
                values = {o.get("value") for o in _dicts(f.get("options"))}
                wanted = cond.get("value") if cond.get("op") == "in" else [cond.get("value")]
                if cond.get("op") in ("eq", "in") and not (set(_list(wanted)) & values):
                    err("R6", "unreachable_outcome", f"field {cond['field']!r} can never equal {cond.get('value')!r} (options: {sorted(values)})")
                    return False
    if src in c.module and src not in live:
        err("R5", "dead_gate", f"waits on module {src!r}, which can itself never open (dependency cycle or dead chain)")
        return False
    return True


def _contradiction(c: _Context, gate: Dict[str, Any]) -> Optional[str]:
    """match=all with two different exit outcomes of the same source that exclude each other."""
    if gate.get("match") != "all":
        return None
    by_src: Dict[str, Set[str]] = {}
    for cond in _conditions(gate):
        if "outcome" in cond:
            by_src.setdefault(cond.get("source"), set()).add(cond["outcome"])
    for src, outs in by_src.items():
        mod = c.module.get(src)
        if not mod or len(outs) < 2:
            continue
        ex = mod.get("exit") or {}
        exits = {ex.get("on_complete"), ex.get("on_reject")} - {None}
        ru = mod.get("rollup") or {}
        exits |= {ru.get("positive"), ru.get("negative")} - {None} if ru.get("strategy") not in (None, "none") else set()
        if len(outs & exits) >= 2:
            return f"waits for {src!r} to end as {sorted(outs & exits)} at the same time; a case has one exit"
    return None


def _gate_open_possible(c: _Context, mod: Dict[str, Any], gate: Any, live: Set[str], stage_pos: Optional[int]) -> bool:
    if not isinstance(gate, dict):
        return True
    conds = _conditions(gate)
    if not conds:
        return True
    if _contradiction(c, gate):
        return False
    ok = [_cond_possible(None, c, mod, x, "", live, stage_pos=stage_pos, report=False) for x in conds]
    return all(ok) if gate.get("match") == "all" else any(ok)


def _r4_r5_r6_gates(r: _Report, c: _Context) -> None:
    # Liveness fixed point: a module is live when it is enabled and its entry gate can open given the
    # modules already known to be live (signals are always live). Cycles never become live.
    enabled = [m for m in c.modules if m.get("enabled", True) is not False]
    live: Set[str] = set()
    changed = True
    while changed:
        changed = False
        for m in enabled:
            if m.get("key") not in live and _gate_open_possible(c, m, m.get("entry_gate"), live | {m.get("key")}, None):
                live.add(m.get("key"))
                changed = True

    for i, mod in enumerate(c.modules):
        mk, p = mod.get("key"), f"modules/{i}"
        enabled_mod = mod.get("enabled", True) is not False
        gate = mod.get("entry_gate")
        if isinstance(gate, dict) and _conditions(gate):
            _report_gate(r, c, mod, gate, f"{p}/entry_gate", live, stage=None, stage_pos=None, enabled_mod=enabled_mod)
            if enabled_mod and mk not in live and not _any_dead_reported(r, mk, None):
                r.error("R5", "dead_gate", f"entry gate of {mk!r} can never open (it depends on modules that can never open)",
                        f"{p}/entry_gate", module=mk)
        for j, s in enumerate(c.stages(mod)):
            sg = s.get("gate")
            if isinstance(sg, dict) and _conditions(sg):
                _report_gate(r, c, mod, sg, f"{p}/stages/{j}/gate", live | {mk}, stage=s.get("key"), stage_pos=j, enabled_mod=enabled_mod)
        # R6 — exits
        ex = mod.get("exit") if isinstance(mod.get("exit"), dict) else {}
        for k in ("on_complete", "on_reject"):
            o = ex.get(k)
            if o in c.outcome and c.outcome[o].get("kind") not in FINAL_KINDS:
                r.error("R6", "exit_not_final", f"exit {k} = {o!r} is a {c.outcome[o].get('kind')} outcome; exits must be "
                                                "positive, negative or neutral", f"{p}/exit/{k}", module=mk)
        if ex.get("on_reject") and not c.can_reject(mod):
            r.warn("R6", "unused_exit", f"exit on_reject = {ex['on_reject']!r} but no approval tier of {mk!r} can reject; "
                                        "the outcome is unreachable", f"{p}/exit/on_reject", module=mk)
        if not ex.get("on_reject") and c.can_reject(mod):
            r.error("R6", "reject_without_exit", f"a tier of {mk!r} can reject but exit.on_reject is not set",
                    f"{p}/exit", module=mk)


def _any_dead_reported(r: _Report, mk: str, stage: Optional[str]) -> bool:
    return any(f["code"] in ("dead_gate", "unreachable_outcome", "gate_unknown_source", "gate_self_reference")
               and f.get("module") == mk and f.get("stage") == stage for f in r.findings)


def _report_gate(r: _Report, c: _Context, mod: Dict[str, Any], gate: Dict[str, Any], path: str, live: Set[str], *,
                 stage: Optional[str], stage_pos: Optional[int], enabled_mod: bool) -> None:
    mk = mod.get("key")
    contradiction = _contradiction(c, gate)
    if contradiction:
        r.error("R5", "dead_gate", contradiction, path, module=mk, stage=stage)
        return
    conds = _conditions(gate)
    results = []
    before = len(r.findings)
    for k, cond in enumerate(conds):
        # Liveness (dead chain) only matters for an enabled module; the rest are static facts.
        results.append(_cond_possible(r, c, mod, cond, f"{path}/conditions/{k}", live if enabled_mod else set(c.module),
                                      stage=stage, stage_pos=stage_pos, report=True))
    if gate.get("match") == "any" and any(results):
        # An "any" gate with at least one possible condition is alive: demote the others to warnings.
        for f in r.findings[before:]:
            if f["severity"] == "error" and f["rule"] in ("R5", "R6"):
                f["severity"] = "warning"
                f["message"] += " (other conditions of this 'any' gate can still open it)"
    elif gate.get("match") == "any" and results and not any(results):
        r.error("R5", "dead_gate", "no condition of this 'any' gate can ever be met", path, module=mk, stage=stage)


# ── R7 ────────────────────────────────────────────────────────────────────────────────────────────
def _r7_adapters(r: _Report, c: _Context, adapters: Optional[Dict[str, Dict[str, Any]]]) -> None:
    for i, mod in enumerate(c.modules):
        ad = mod.get("adapter")
        if not isinstance(ad, dict):
            continue
        mk, p = mod.get("key"), f"modules/{i}/adapter"
        if adapters is None:
            r.warn("R7", "adapter_unverified", f"adapter {ad.get('key')!r} cannot be checked: no adapter registry given", p, module=mk)
            continue
        reg = adapters.get(ad.get("key"))
        if reg is None:
            r.error("R7", "unknown_adapter", f"adapter {ad.get('key')!r} is not installed on this platform", p, module=mk)
            continue
        if ad.get("version") not in _list(reg.get("versions")):
            r.error("R7", "unknown_adapter", f"adapter {ad.get('key')!r} has no version {ad.get('version')!r} "
                                             f"(installed: {_list(reg.get('versions'))})", f"{p}/version", module=mk)
        for h in _list(ad.get("hooks")):
            if h not in _list(reg.get("hooks")):
                r.error("R7", "adapter_hook_unsupported", f"adapter {ad.get('key')!r} does not implement hook {h!r}",
                        f"{p}/hooks", module=mk)


# ── R8 ────────────────────────────────────────────────────────────────────────────────────────────
def _r8_fields(r: _Report, c: _Context) -> None:
    groups = [(f"subjects/{i}/fields", _dicts(s.get("fields")), {}) for i, s in enumerate(c.subjects)]
    for i, mod in enumerate(c.modules):
        for j, s in enumerate(c.stages(mod)):
            groups.append((f"modules/{i}/stages/{j}/fields", _dicts(s.get("fields")), {"module": mod.get("key"), "stage": s.get("key")}))
    for path, fields, where in groups:
        for k, f in enumerate(fields):
            fp, v = f"{path}/{k}", f.get("validation") if isinstance(f.get("validation"), dict) else {}
            w = dict(where, field=f.get("key"))
            for lo, hi in (("min", "max"), ("min_length", "max_length"), ("min_date", "max_date")):
                if lo in v and hi in v and isinstance(v[lo], (int, float, str)) and type(v[lo]) is type(v[hi]) and v[lo] > v[hi]:
                    r.error("R8", "field_validation", f"{lo} {v[lo]!r} is greater than {hi} {v[hi]!r}", f"{fp}/validation", **w)
            if "pattern" in v:
                try:
                    re.compile(v["pattern"])
                except re.error as exc:
                    r.error("R8", "field_validation", f"pattern does not compile: {exc}", f"{fp}/validation/pattern", **w)
            if f.get("type") == "money" and not v.get("currency") and not c.workspace_currency:
                r.warn("R8", "money_without_currency", "money field without a currency and no workspace currency", fp, **w)
            if f.get("type") == "person":
                role = v.get("role")
                if role is not None:
                    _role_ref(r, c, role, f"{fp}/validation/role", **w)
            type_specific = {"pattern": {"text", "long_text"}, "accept": {"file"}, "max_size_mb": {"file"}, "max_files": {"file"},
                             "currency": {"money"}, "role": {"person"}, "min_date": {"date"}, "max_date": {"date"}}
            for key, types in type_specific.items():
                if key in v and f.get("type") not in types:
                    r.error("R8", "field_validation", f"validation {key!r} does not apply to a {f.get('type')} field", f"{fp}/validation/{key}", **w)


# ── R9 ────────────────────────────────────────────────────────────────────────────────────────────
def _r9_rollup_views(r: _Report, c: _Context) -> None:
    for i, mod in enumerate(c.modules):
        mk, p = mod.get("key"), f"modules/{i}"
        fmap = c.field_map(mod)
        ru = mod.get("rollup") if isinstance(mod.get("rollup"), dict) else None
        if ru and ru.get("strategy") not in (None, "none"):
            refs = _list(ru.get("fields"))
            if not refs:
                r.error("R9", "rollup_invalid", f"roll-up {ru.get('strategy')!r} needs fields", f"{p}/rollup", module=mk)
            for ref in refs:
                st, _, fk = str(ref).partition(".")
                f = fmap.get(st, {}).get(fk)
                if f is None:
                    r.error("R9", "unknown_field", f"roll-up field {ref!r} does not exist", f"{p}/rollup/fields", module=mk)
                elif f.get("type") not in SCORABLE_TYPES:
                    r.error("R9", "rollup_invalid", f"roll-up field {ref!r} is a {f.get('type')} field and cannot be scored",
                            f"{p}/rollup/fields", module=mk)
                elif ru.get("strategy") == "sum_under" and f.get("type") not in ("number", "money"):
                    r.error("R9", "rollup_invalid", f"sum_under needs number/money fields; {ref!r} is {f.get('type')}",
                            f"{p}/rollup/fields", module=mk)
            if ru.get("strategy") == "count_at_least" and not ru.get("n"):
                r.error("R9", "rollup_invalid", "count_at_least needs n", f"{p}/rollup", module=mk)
            if ru.get("strategy") == "sum_under" and ru.get("limit") is None:
                r.error("R9", "rollup_invalid", "sum_under needs limit", f"{p}/rollup", module=mk)
            for k in ("positive", "negative"):
                if ru.get(k) is not None:
                    _outcome_ref(r, c, ru[k], f"{p}/rollup/{k}", module=mk)
            for st, fields in fmap.items():
                for fk, f in fields.items():
                    if f.get("affects_outcome") and f"{st}.{fk}" not in refs:
                        r.warn("R9", "affects_outcome_unused", f"field {st}.{fk} is marked affects_outcome but the roll-up ignores it",
                               f"{p}/rollup/fields", module=mk, stage=st, field=fk)
        stages = c.stage_index(mod)
        visible = set(_list(mod.get("members"))) | {k for k, ro in c.role.items() if ro.get("scope") == "workspace"}
        for j, v in enumerate(_dicts(mod.get("views"))):
            vp = f"{p}/views/{j}"
            for role in _list(v.get("audience")):
                if _role_ref(r, c, role, f"{vp}/audience", module=mk) and role not in visible:
                    r.warn("R9", "view_audience_cannot_see", f"view {v.get('key')!r}: {role!r} is not a member role of {mk!r}",
                           f"{vp}/audience", module=mk)
            extra = set(_list(v.get("default_for"))) - set(_list(v.get("audience")))
            if extra:
                r.error("R9", "view_default_not_in_audience", f"view {v.get('key')!r} is default for {sorted(extra)} who are not in its audience",
                        f"{vp}/default_for", module=mk)
            flt = v.get("filter") if isinstance(v.get("filter"), dict) else {}
            for st in _list(flt.get("stage")):
                if st not in stages:
                    r.error("R2", "unknown_stage", f"view {v.get('key')!r} filters on unknown stage {st!r}", f"{vp}/filter/stage", module=mk)
            for o in _list(flt.get("reached")):
                if _outcome_ref(r, c, o, f"{vp}/filter/reached", module=mk) and o not in c.reachable_outcomes(mk):
                    r.error("R6", "unreachable_outcome", f"view {v.get('key')!r} filters on {o!r}, which {mk!r} can never reach",
                            f"{vp}/filter/reached", module=mk)
            sf = flt.get("subject_field") if isinstance(flt.get("subject_field"), dict) else None
            if sf and sf.get("field") not in {f.get("key") for f in _dicts((c.subject.get(mod.get("subject")) or {}).get("fields"))}:
                r.error("R2", "unknown_field", f"view {v.get('key')!r} filters on unknown subject field {sf.get('field')!r}",
                        f"{vp}/filter/subject_field", module=mk)


# ── R10 ───────────────────────────────────────────────────────────────────────────────────────────
def _r10_grants(r: _Report, c: _Context) -> None:
    publishers = set()
    for i, g in enumerate(c.grants):
        for role in _list(g.get("roles")):
            ro = c.role.get(role)
            if ro and ro.get("read_only") and g.get("action") in WRITE_GRANTS:
                r.error("R10", "read_only_grant", f"read-only role {role!r} cannot hold write grant {g.get('action')!r}",
                        f"permissions/{i}/roles")
        if g.get("action") == "publish_release":
            publishers |= set(_list(g.get("roles")))
    if not publishers:
        r.warn("R10", "no_publisher", "no role holds publish_release; only the platform operator can publish", "permissions")
