"""Publish-time validation of a configurator manifest (F4a, first-party).

``check_manifest`` is pure (no DB): give it the manifest and the platform module catalog and it
returns findings. Publishing is refused when any finding has severity ``error``; warnings are
returned to the publisher and stored nowhere else. Checks, in order:

1. shape — JSON Schema of the v5 ``manifest()`` (manifest.schema.json, draft 2020-12);
2. modules — unique keys; built-ins resolve to the catalog (key or configurator alias, e.g.
   pex -> project_excellence), never a retired key or a delegation-only scope; custom keys are
   valid (``is_valid_module_key``), never a built-in key/alias; custom modules have stages with
   unique orders and unique field keys;
3. gates — every entry/stage gate compiles to the matrix-gate/1 JsonLogic dialect and passes
   ``gates.lint``; every condition source is a module (key or alias) or signal of THIS manifest;
4. roll-ups — compile + lint; ``custom`` strategy parks the module (warning);
5. forms (custom modules) — every stage compiles to a valid draft-07 JSON Schema
   (``forms.stage_form`` + ``Draft7Validator.check_schema``); free-text validation hints the
   compiler cannot read become ``unparsed_hint`` warnings; outcome-affecting fields the roll-up
   cannot score become ``rollup_field_ignored`` warnings (F3 findings 2 and 6);
6. runtime — ``ModuleRuntime`` can be built for every custom module.
7. G3 creator rule — ``stages[].restricted_to: "site_creator"`` (schema enum): on a custom module
   whose stage chain does not start with the executive tier → warning ``creator_rule_first_tier``
   (the rule then binds that first tier, e.g. only the supervisor who created the site); on a
   built-in module → warning ``creator_rule_builtin_ignored`` (built-ins run their own code).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

from . import forms, gates
from .runtime import ModuleRuntime

OUTCOMES = ("pending", "allocated", "in progress", "submitted", "rejected", "approved", "done", "skipped")
_SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.schema.json")


@lru_cache(maxsize=1)
def _manifest_validator():
    import jsonschema

    with open(_SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)
    return jsonschema.Draft202012Validator(schema)


def _f(findings: List[Dict[str, Any]], severity: str, code: str, message: str, **where: Any) -> None:
    findings.append({"severity": severity, "code": code, "message": message,
                     **{k: v for k, v in where.items() if v is not None}})


def _gate_conditions(gate: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not isinstance(gate, dict):
        return []
    return list(gate.get("conditions", gate.get("conds")) or [])


def check_manifest(
    manifest: Any,
    *,
    catalog: Dict[str, Dict[str, Any]],
    workspace_ref: Optional[str] = None,
) -> Dict[str, Any]:
    """-> {"ok": bool, "errors": int, "warnings": int, "findings": [...], "modules": [...]}.

    ``catalog`` maps built-in key -> {"config_key", "surface", "retired"} (module_catalog).
    ``modules`` lists the resolved modules: {key (runtime key), manifest_key, kind, enabled}.
    """
    findings: List[Dict[str, Any]] = []
    resolved: List[Dict[str, Any]] = []

    # 1. shape
    for e in sorted(_manifest_validator().iter_errors(manifest), key=lambda e: list(map(str, e.absolute_path))):
        path = "/".join(map(str, e.absolute_path)) or "(manifest)"
        _f(findings, "error", "schema", f"{path}: {e.message}", path=path)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("modules"), list) \
            or not all(isinstance(m, dict) for m in manifest["modules"]):
        return _report(findings, resolved)

    alias = {}  # manifest key / alias -> runtime key, for built-ins
    for key, c in catalog.items():
        alias[key] = key
        if c.get("config_key"):
            alias[c["config_key"]] = key

    ws = manifest.get("workspace") or {}
    if workspace_ref and isinstance(ws, dict) and ws.get("id") not in (None, workspace_ref):
        _f(findings, "warning", "workspace_ref_mismatch",
           f"manifest.workspace.id is {ws.get('id')!r} but it is being published to {workspace_ref!r}")

    # 2. modules
    seen_manifest = _resolve_modules(findings, resolved, manifest["modules"], catalog, alias)
    known_sources = set(seen_manifest) | {alias.get(k, k) for k in seen_manifest} | \
        {s.get("key") for s in (manifest.get("signals") or []) if isinstance(s, dict)}
    enabled_sources = {k for k, m in seen_manifest.items() if m.get("enabled", True)}
    enabled_sources |= {alias.get(k, k) for k in enabled_sources}

    # 3–6 per module
    for mkey, m in seen_manifest.items():
        is_custom = m.get("type") != "builtin"
        _check_gate(findings, mkey, m.get("entry_gate"), known_sources, enabled_sources, where="entry_gate")
        _check_rollup(findings, mkey, m, is_custom)
        if is_custom:  # built-ins run on their bespoke implementations; their stages are descriptive
            _check_custom_module(findings, mkey, m, known_sources, enabled_sources)
        else:
            for s in m.get("stages") or []:
                if isinstance(s, dict) and s.get("restricted_to"):
                    _f(findings, "warning", "creator_rule_builtin_ignored",
                       "the 'only the site's creator' rule is not enforced on built-in modules "
                       "(they run their own code)", module=mkey, stage=s.get("order"))
    return _report(findings, resolved)


def _resolve_builtin(findings, mkey: str, catalog, alias) -> Optional[str]:
    rkey = alias.get(mkey)
    cat = catalog.get(rkey) if rkey else None
    if not cat:
        _f(findings, "error", "unknown_builtin", f"{mkey!r} is not a built-in module of this platform", module=mkey)
    elif cat.get("retired"):
        _f(findings, "error", "retired_builtin", f"built-in {mkey!r} is retired", module=mkey)
    elif cat.get("surface") != "module":
        _f(findings, "error", "not_a_module", f"{mkey!r} is a delegation scope, not a module", module=mkey)
    else:
        return rkey
    return None


def _resolve_custom(findings, mkey: str, m: Dict[str, Any], alias) -> Optional[str]:
    from app.services.module_registry_service import is_valid_module_key

    if not is_valid_module_key(mkey):
        _f(findings, "error", "invalid_module_key", f"{mkey!r} is not a valid module key", module=mkey)
        return None
    if mkey in alias:
        _f(findings, "error", "custom_key_collides", f"custom module {mkey!r} uses a built-in module key", module=mkey)
        return None
    route = m.get("route")
    if route and route != f"/m/{mkey}":
        _f(findings, "warning", "custom_route", f"custom module route should be /m/{mkey} (got {route})", module=mkey)
    return mkey


def _resolve_modules(findings, resolved, modules, catalog, alias) -> Dict[str, Dict[str, Any]]:
    """Unique keys; built-ins resolved through the catalog; custom keys valid and not built-in."""
    seen_manifest: Dict[str, Dict[str, Any]] = {}
    seen_runtime: set = set()
    for m in modules:
        mkey = m.get("key")
        if not isinstance(mkey, str):
            continue
        if mkey in seen_manifest:
            _f(findings, "error", "duplicate_module", f"module key {mkey!r} appears twice", module=mkey)
            continue
        seen_manifest[mkey] = m
        kind = "builtin" if m.get("type") == "builtin" else "custom"
        rkey = _resolve_builtin(findings, mkey, catalog, alias) if kind == "builtin" \
            else _resolve_custom(findings, mkey, m, alias)
        if rkey is None:
            continue
        if rkey in seen_runtime:
            _f(findings, "error", "duplicate_module", f"{mkey!r} names built-in {rkey!r} twice", module=mkey)
            continue
        seen_runtime.add(rkey)
        resolved.append({"key": rkey, "manifest_key": mkey, "kind": kind, "enabled": bool(m.get("enabled", True))})
    return seen_manifest


def _check_rollup(findings, mkey: str, m: Dict[str, Any], is_custom: bool) -> None:
    try:
        rule = gates.compile_rollup(m.get("rollup"))
    except gates.GateError as exc:
        _f(findings, "error", "rollup_invalid", str(exc), module=mkey)
        return
    for p in gates.lint(rule):
        _f(findings, "error", "rollup_lint", p, module=mkey)
    if rule == "pending_engineering" and is_custom:
        _f(findings, "warning", "rollup_custom",
           "roll-up strategy 'custom' needs engineering; the module will park when it finishes", module=mkey)


def _check_custom_module(findings, mkey: str, m: Dict[str, Any], known_sources, enabled_sources) -> None:
    stages = [s for s in (m.get("stages") or []) if isinstance(s, dict)]
    if m.get("enabled", True) and not stages:
        _f(findings, "error", "no_stages", "a custom module needs at least one stage", module=mkey)
    orders = [s.get("order") for s in stages]
    if len(set(orders)) != len(orders):
        _f(findings, "error", "duplicate_stage_order", f"stage orders repeat: {orders}", module=mkey)
        return
    last = max(orders) if orders else None
    for s in stages:
        _check_stage(findings, mkey, s, last, known_sources, enabled_sources)
    if stages:
        try:
            rt = ModuleRuntime(m, release="publish-check")
        except Exception as exc:  # noqa: BLE001
            _f(findings, "error", "runtime_invalid", f"module cannot be run: {exc}", module=mkey)
            return
        for s in rt.stages:
            if s.get("restricted_to") == "site_creator" and rt.chain(s)[0] != "executive":
                _f(findings, "warning", "creator_rule_first_tier",
                   f"'only the site's creator' binds the first step, which here is the {rt.chain(s)[0]} "
                   f"tier: only a {rt.chain(s)[0].replace('_', ' ')} who created the site can do it",
                   module=mkey, stage=s.get("order"))


def _check_stage(findings, mkey: str, s: Dict[str, Any], last, known_sources, enabled_sources) -> None:
    import jsonschema

    order = s.get("order")
    if s.get("terminal") and order != last:
        _f(findings, "warning", "terminal_not_last",
           "a terminal stage before the last stage ends the module there", module=mkey, stage=order)
    if not s.get("approvers"):
        _f(findings, "warning", "no_approver",
           "stage has no approvers; the runtime defaults it to a supervisor", module=mkey, stage=order)
    if s.get("outcome") not in OUTCOMES:
        _f(findings, "error", "stage_outcome", f"outcome {s.get('outcome')!r} is not in the vocabulary",
           module=mkey, stage=order)
    keys = [f.get("key") for f in (s.get("fields") or []) if isinstance(f, dict)]
    if len(set(keys)) != len(keys):
        _f(findings, "error", "duplicate_field", f"field keys repeat: {keys}", module=mkey, stage=order)
        return
    if s.get("gate"):
        _check_gate(findings, mkey, s.get("gate"), known_sources, enabled_sources,
                    where=f"stages[{order}].gate", stage=order)
    try:
        form = forms.stage_form(s, file_mode="ref")
        jsonschema.Draft7Validator.check_schema(form["schema"])
    except Exception as exc:  # noqa: BLE001 — any compile failure is a publish error
        _f(findings, "error", "form_invalid", f"stage form does not compile: {exc}", module=mkey, stage=order)
        return
    for u in form["unparsed"]:
        _f(findings, "warning", "unparsed_hint",
           f"validation hint {u['hint']!r} of {u['kind']} field is not machine-readable; shown as help text",
           module=mkey, stage=order, field=u["field"])
    for fdef in s.get("fields") or []:
        if fdef.get("affects_outcome") and fdef.get("kind") not in ("choice", "yesno"):
            _f(findings, "warning", "rollup_field_ignored",
               f"{fdef.get('kind')} field marked affects_outcome cannot be scored by the roll-up; ignored",
               module=mkey, stage=order, field=fdef.get("key"))


def _check_gate(findings, mkey, gate, known_sources, enabled_sources, *, where: str, stage=None) -> None:
    if gate is None:
        return
    try:
        rule = gates.compile_gate(gate)
    except gates.GateError as exc:
        _f(findings, "error", "gate_invalid", f"{where}: {exc}", module=mkey, stage=stage)
        return
    for p in gates.lint(rule) if rule is not None else []:
        _f(findings, "error", "gate_lint", f"{where}: {p}", module=mkey, stage=stage)
    for c in _gate_conditions(gate):
        src = c.get("source", c.get("src"))
        if src == mkey and "stage" not in c:
            _f(findings, "error", "gate_self_reference", f"{where}: waits on its own module", module=mkey, stage=stage)
        elif src not in known_sources:
            _f(findings, "error", "gate_unknown_source",
               f"{where}: condition waits on {src!r}, which is not a module or signal of this workspace",
               module=mkey, stage=stage)
        elif src not in enabled_sources:
            _f(findings, "warning", "gate_disabled_source",
               f"{where}: condition waits on disabled module {src!r}; the gate can never open",
               module=mkey, stage=stage)
        out = c.get("outcome", c.get("out"))
        if out is not None and out not in OUTCOMES:
            _f(findings, "warning", "gate_outcome",
               f"{where}: outcome {out!r} is not in the platform vocabulary", module=mkey, stage=stage)


def _report(findings: List[Dict[str, Any]], resolved: List[Dict[str, Any]]) -> Dict[str, Any]:
    errors = sum(1 for f in findings if f["severity"] == "error")
    return {"ok": errors == 0, "errors": errors, "warnings": len(findings) - errors,
            "findings": findings, "modules": resolved}
