"""Plan + apply the move of ONE running custom-module case from release vN to release vM (G3 #2).

Pure functions over the interpreter state (no DB). Idea from the user's operaton-plat
``op_migrate_running`` (Operaton process-instance migration: map activities old -> new, refuse what
cannot be mapped, never lose data); the rules below are ours, for the linear stage model of
runtime.py.

Stage mapping (source stage -> target stage), first rule that applies:
  1. ``explicit``  — the caller's ``stage_map`` {"<from order>": <to order>|null};
  2. ``same``      — same order AND same name (case/space-insensitive);
  3. ``by_name``   — exactly one target stage with the same name (stage inserted / removed before it);
  4. ``by_order``  — same order, different name (renamed);
  5. ``unmapped``.

A running case (status open / in_progress) is COMPATIBLE when:
  * the module exists in the target release, is custom and enabled;
  * its current stage maps to a target stage, and every completed stage that maps lands BEFORE it
    (order kept), with no two stages landing on the same target;
  * mid-stage (step > 0: someone already acted in this pass) the target stage's tier chain starts
    with the same tiers already passed and still has a step left — otherwise blocked, unless
    ``restart_stage_on_chain_change`` (the stage restarts at its first step, values kept).
Warnings (never blocking): a completed stage dropped by the target, a field dropped / changed kind /
newly required, a new target stage before the current one that the case will skip, a tier chain
change on a later step, delegation switched.

Closed cases (completed / rejected / parked) are ``not_in_flight``: they keep the release they
finished on.

``apply`` returns the new state: ``release`` = target, stage/completed/values/verdicts re-keyed to
target orders, values of fields the target no longer has dropped from the live case (the
caller keeps the full pre-migration state in the migration journal + audit provenance), ``reached``
recomputed with the target outcomes, then ONE hash-chained ``release_migrated`` event (so the case's
audit chain stays verifiable across releases).
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Tuple

from .runtime import Actor, ModuleRuntime

IN_FLIGHT = ("open", "in_progress", "locked")


def _norm(name: Any) -> str:
    return " ".join(str(name or "").lower().split())


def stage_mapping(src: ModuleRuntime, dst: ModuleRuntime,
                  explicit: Optional[Dict[str, Any]] = None) -> Dict[int, Tuple[Optional[int], str]]:
    """{source order: (target order | None, how)} for every stage of the source module."""
    explicit = {str(k): v for k, v in (explicit or {}).items()}
    by_order = {s["order"]: s for s in dst.stages}
    by_name: Dict[str, List[int]] = {}
    for s in dst.stages:
        by_name.setdefault(_norm(s["name"]), []).append(s["order"])
    out: Dict[int, Tuple[Optional[int], str]] = {}
    for s in src.stages:
        o, n = s["order"], _norm(s["name"])
        if str(o) in explicit:
            t = explicit[str(o)]
            out[o] = (t if isinstance(t, int) and t in by_order else None, "explicit")
        elif o in by_order and _norm(by_order[o]["name"]) == n:
            out[o] = (o, "same")
        elif len(by_name.get(n, [])) == 1:
            out[o] = (by_name[n][0], "by_name")
        elif o in by_order:
            out[o] = (o, "by_order")
        else:
            out[o] = (None, "unmapped")
    return out


def _stage_ref(rt: ModuleRuntime, order: Optional[int], step: int = 0) -> Optional[Dict[str, Any]]:
    if order is None:
        return None
    st = rt._stage(order)
    chain = rt.chain(st)
    return {"order": order, "name": st["name"], "step": step,
            "role": chain[step] if step < len(chain) else None, "chain": chain,
            "restricted_to": st.get("restricted_to")}


def _issue(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"code": code, "message": message, **extra}


def _check_mapping(state, src, dst, mapping, tv, blocking, warnings) -> Tuple[Optional[int], List[int]]:
    """Current stage + completed stages onto the target: -> (target stage, completed target stages)."""
    cur = state["stage"]
    tgt = mapping.get(cur, (None, "unmapped"))[0]
    if tgt is None:
        blocking.append(_issue("stage_missing",
                               f"Current stage {cur} \u201c{src._stage(cur)['name']}\u201d has no counterpart in {tv}.",
                               stage=cur))
    completed: List[int] = []
    for o in state.get("completed") or []:
        t = mapping.get(o, (None, "unmapped"))[0]
        if t is None:
            warnings.append(_issue("completed_stage_dropped",
                                   f"Completed stage {o} \u201c{src._stage(o)['name']}\u201d does not exist in {tv}; "
                                   f"its values stay in the migration journal only.", stage=o))
        else:
            completed.append(t)
    targets = completed + ([tgt] if tgt is not None else [])
    if len(set(targets)) != len(targets):
        blocking.append(_issue("mapping_not_injective", "Two stages of the case map onto the same target stage."))
    if tgt is not None and any(t >= tgt for t in completed):
        blocking.append(_issue("mapping_not_monotonic",
                               "A completed stage maps onto or after the case's current stage."))
    return tgt, completed


def _check_chain(state, src, dst, tgt, completed, tv, restart, blocking, warnings) -> Tuple[int, List[Any]]:
    """Tier chain of the current stage (mid-stage moves) + stages the case would skip -> (step, pass)."""
    step, pass_ = state.get("step", 0), list(state.get("pass") or [])
    cur = state["stage"]
    src_chain, dst_chain = src.chain(src._stage(cur)), dst.chain(dst._stage(tgt))
    change = f"{'/'.join(src_chain)} -> {'/'.join(dst_chain)}"
    if step > 0 and (dst_chain[:step] != src_chain[:step] or step >= len(dst_chain)):
        if restart:
            warnings.append(_issue("stage_restarted", f"The tier chain of the current stage changed ({change}); "
                                                      "the stage restarts at its first step."))
            step, pass_ = 0, []
        else:
            blocking.append(_issue("chain_changed_mid_stage",
                                   f"Someone already acted in this stage and its tier chain changed ({change})."))
    elif dst_chain != src_chain:
        warnings.append(_issue("chain_changed", f"Tier chain of the current stage: {change}."))
    for s in dst.stages:
        if s["order"] < tgt and s["order"] not in completed:
            warnings.append(_issue("skips_new_stage",
                                   f"Stage {s['order']} \u201c{s['name']}\u201d of {tv} comes before the case's current "
                                   f"stage; the case will not pass through it.", stage=s["order"]))
    if (dst._stage(tgt).get("restricted_to") or None) != (src._stage(cur).get("restricted_to") or None):
        warnings.append(_issue("creator_rule_changed",
                               "The current stage's 'only the site's creator' rule differs in the target."))
    return step, pass_


def _carry_values(state, src, dst, mapping, fields) -> Dict[str, Dict[str, Any]]:
    """Re-key field values to target stages; fields the target lacks are dropped (journal keeps them)."""
    values: Dict[str, Dict[str, Any]] = {}
    for o_key, vals in (state.get("values") or {}).items():
        o = int(o_key)
        t = mapping.get(o, (None, "unmapped"))[0]
        if t is None:
            fields["dropped"] += [{"stage": o, "field": k} for k in vals]
            continue
        dst_fields = {f["key"]: f for f in dst._stage(t).get("fields") or []}
        src_fields = {f["key"]: f for f in src._stage(o).get("fields") or []}
        values[str(t)] = {k: v for k, v in vals.items() if k in dst_fields}
        for k in vals:
            if k not in dst_fields:
                fields["dropped"].append({"stage": o, "field": k})
                continue
            fields["kept"].append({"stage": t, "field": k})
            if k in src_fields and src_fields[k].get("kind") != dst_fields[k].get("kind"):
                fields["kind_changed"].append({"stage": t, "field": k, "from": src_fields[k].get("kind"),
                                               "to": dst_fields[k].get("kind")})
    return values


def _field_warnings(dst, values, submitted: List[int], fields, tv, warnings) -> None:
    for t in submitted:
        have = values.get(str(t), {})
        for f in dst._stage(t).get("fields") or []:
            if f.get("required") and f["key"] not in have:
                fields["new_required"].append({"stage": t, "field": f["key"]})
    if fields["dropped"]:
        warnings.append(_issue("fields_dropped", f"{len(fields['dropped'])} field value(s) have no field in {tv}; "
                                                 "kept in the migration journal and the audit provenance."))
    if fields["kind_changed"]:
        warnings.append(_issue("field_kind_changed", f"{len(fields['kind_changed'])} kept field(s) changed kind."))
    if fields["new_required"]:
        warnings.append(_issue("new_required_field",
                               f"{len(fields['new_required'])} required field(s) of {tv} have no value on an "
                               "already-submitted stage; they will not be asked again."))


def plan(state: Dict[str, Any], src: ModuleRuntime, dst: Optional[ModuleRuntime], *,
         target_enabled: bool = True, target_version: Optional[int] = None,
         stage_map: Optional[Dict[str, Any]] = None,
         restart_stage_on_chain_change: bool = False) -> Dict[str, Any]:
    """-> {in_flight, compatible, blocking[], warnings[], stage_mapping[], before, after, fields{}, new_core}."""
    tv = f"v{target_version}" if target_version is not None else "the target release"
    status = state.get("status")
    before = _stage_ref(src, state.get("stage"), state.get("step", 0)) if status in IN_FLIGHT else None
    res: Dict[str, Any] = {"in_flight": status in IN_FLIGHT, "case_status": status, "compatible": False,
                           "blocking": [], "warnings": [], "stage_mapping": [], "before": before,
                           "after": None, "fields": {"kept": [], "dropped": [], "kind_changed": [],
                                                     "new_required": []}, "new_core": None}
    blocking, warnings = res["blocking"], res["warnings"]
    if status not in IN_FLIGHT:
        blocking.append(_issue("not_in_flight", f"The case is {status}; finished cases keep their release."))
        return res
    if dst is None:
        blocking.append(_issue("module_not_in_target", f"The module does not exist in {tv}."))
        return res
    if not target_enabled:
        blocking.append(_issue("module_disabled_in_target", f"The module is switched off in {tv}."))
        return res

    mapping = stage_mapping(src, dst, stage_map)
    res["stage_mapping"] = [
        {"from": {"order": o, "name": src._stage(o)["name"]},
         "to": None if t is None else {"order": t, "name": dst._stage(t)["name"]}, "how": how}
        for o, (t, how) in sorted(mapping.items())]
    tgt, completed = _check_mapping(state, src, dst, mapping, tv, blocking, warnings)
    step, pass_ = state.get("step", 0), list(state.get("pass") or [])
    if tgt is not None:
        step, pass_ = _check_chain(state, src, dst, tgt, completed, tv, restart_stage_on_chain_change,
                                   blocking, warnings)
    if bool(src.tiers.get("delegation")) != bool(dst.tiers.get("delegation")):
        warnings.append(_issue("delegation_changed", "The module's delegation tier is switched differently in the target."))
    values = _carry_values(state, src, dst, mapping, res["fields"])
    _field_warnings(dst, values, completed + ([tgt] if tgt is not None and step > 0 else []), res["fields"], tv,
                    warnings)

    if not blocking:
        res["compatible"] = True
        res["after"] = _stage_ref(dst, tgt, step)
        verdicts = [dict(v, stage=mapping[v["stage"]][0]) for v in state.get("verdicts") or []
                    if mapping.get(v.get("stage"), (None, ""))[0] is not None]
        res["new_core"] = {"stage": tgt, "step": step, "pass": pass_, "completed": sorted(completed),
                           "values": values, "verdicts": verdicts}
    return res


def apply(state: Dict[str, Any], dst: ModuleRuntime, p: Dict[str, Any], *, actor: Actor,
          payload: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """-> (new_state, release_migrated event). ``p`` must be a compatible plan for ``state``."""
    if not p.get("compatible") or not p.get("new_core"):
        raise ValueError("cannot apply an incompatible migration plan")
    s = copy.deepcopy(state)
    s.update(copy.deepcopy(p["new_core"]))
    s["release"] = dst.release
    s["reached"] = dst._reached(s)
    s, ev = dst._emit(s, "release_migrated", actor, payload)
    return s, ev
