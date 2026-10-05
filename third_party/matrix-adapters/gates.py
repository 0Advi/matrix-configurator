"""Gate conditions for the Matrix module runtime — manifest -> JsonLogic -> verdict.

First-party glue (not third-party code). It compiles the configurator's gate and roll-up
definitions into a restricted JsonLogic dialect ("matrix-gate/1") and evaluates them with the
vendored ``panzi-json-logic`` (MIT, third_party/panzi-json-logic). The JS twin is ``gates.mjs``
(evaluated with the vendored ``json-logic-js``); ``test/`` proves both compile byte-identical
rules and return identical verdicts on the real seed + production flows.

Case facts (the ``data`` every rule is evaluated against) — built by the runtime per case/site:

    {
      "reached": {"bd": ["submitted", "allocated", "approved", "done"], "legal": [...], "<signal>": [...]},
      "stages":  {"project": [1, 2]},          # orders of COMPLETED stages, per module (stage-level gates, G-A)
      "fields":  {"legal": {"ddr_verdict": "positive"}}   # submitted field values (field conditions, G-E)
    }

Condition forms accepted (manifest form first, v5 document form second):
    {"source": "bd", "outcome": "done"}            | {"src": "bd", "out": "done"}      module/signal outcome
    {"source": "project", "stage": 2}              | {"src": "project", "stage": 2}    stage N of a module completed
    {"source": "legal", "field": "ddr_verdict", "op": "===", "value": "positive"}       field comparison
Gates: manifest ``{"match": "all"|"any", "conditions": [...], "refusal_message": str}`` or
v5 document ``{"match", "conds", "refusal"}``. ``None`` / no conditions = always open.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_HERE, "..", "panzi-json-logic")
if _VENDOR not in sys.path:  # F4: replace with your vendored import path (see docs/oss/for-F4.md)
    sys.path.insert(0, _VENDOR)
from json_logic import jsonLogic  # noqa: E402  (vendored panzi-json-logic 1.0.1, MIT)

DIALECT = "matrix-gate/1"

# Operators allowed in published rules. Soft equality (==, !=) and arithmetic other than "+" are
# excluded: they are exactly where the JS and Python JsonLogic ports disagree (see test/differential).
ALLOWED_OPS = frozenset([
    "and", "or", "!", "!!", "if", "===", "!==", "<", "<=", ">", ">=",
    "in", "var", "missing", "missing_some", "all", "some", "none", "filter", "reduce", "+",
])
FIELD_OPS = frozenset(["===", "!==", "<", "<=", ">", ">=", "in"])
BINARY_OPS = frozenset(["===", "!==", "<", "<=", ">", ">="])


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _mixes_bool_number(args: List[Any]) -> bool:
    kinds = {("bool" if isinstance(a, bool) else "num" if _is_number(a) else "other") for a in args}
    return {"bool", "num"} <= kinds

# Roll-up vocab — mirrors building-blocks/from-design/validation.mjs evaluateRollup (INFERRED there).
YES = ["yes", "true", "done", "ready"]
NO = ["no", "false", "blocked"]
NA = ["n/a", "na"]


class GateError(ValueError):
    pass


def _cond_parts(c: Dict[str, Any]) -> Dict[str, Any]:
    src = c.get("source", c.get("src"))
    if not isinstance(src, str) or not src:
        raise GateError(f"condition without a source: {c!r}")
    return {
        "src": src,
        "out": c.get("outcome", c.get("out")),
        "stage": c.get("stage"),
        "field": c.get("field"),
        "op": c.get("op", "==="),
        "value": c.get("value"),
    }


def compile_condition(c: Dict[str, Any]) -> Dict[str, Any]:
    p = _cond_parts(c)
    if p["field"] is not None:
        if p["op"] not in FIELD_OPS:
            raise GateError(f"field op {p['op']!r} not allowed (use one of {sorted(FIELD_OPS)})")
        return {p["op"]: [{"var": f"fields.{p['src']}.{p['field']}"}, p["value"]]}
    if p["stage"] is not None:
        if not isinstance(p["stage"], int) or isinstance(p["stage"], bool):
            raise GateError(f"stage must be the stage order (int): {c!r}")
        return {"in": [p["stage"], {"var": [f"stages.{p['src']}", []]}]}
    if not isinstance(p["out"], str) or not p["out"]:
        raise GateError(f"condition without an outcome: {c!r}")
    return {"in": [p["out"], {"var": [f"reached.{p['src']}", []]}]}


def _conds(gate: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not gate:
        return []
    return list(gate.get("conditions", gate.get("conds")) or [])


def compile_gate(gate: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Gate -> JsonLogic rule returning a boolean; None when the gate is open by definition."""
    conds = _conds(gate)
    if not conds:
        return None
    match = gate.get("match", "all")
    if match not in ("all", "any"):
        raise GateError(f"match must be 'all' or 'any', got {match!r}")
    rules = [compile_condition(c) for c in conds]
    return {"!!": [{"and" if match == "all" else "or": rules}]}


def compile_rollup(rollup: Optional[Dict[str, Any]]) -> Any:
    """Roll-up strategy -> JsonLogic over {"checks": [str...], "sum": number|null}.

    Returns 'approved' | 'rejected' | 'pending' | 'pending_engineering'.
    """
    r = rollup or {}
    strategy = r.get("strategy", "all_positive")
    checks = {"var": ["checks", []]}
    any_no = {"some": [checks, {"in": [{"var": ""}, NO]}]}
    all_yes_na = {"all": [checks, {"in": [{"var": ""}, YES + NA]}]}
    if strategy == "custom":
        return "pending_engineering"
    if strategy in ("all_positive", "any_negative"):
        return {"if": [any_no, "rejected", all_yes_na, "approved", "pending"]}
    if strategy == "count_at_least":
        n = int(r.get("n") or 0)
        yes_count = {"reduce": [checks, {"+": [{"var": "accumulator"},
                                                 {"if": [{"in": [{"var": "current"}, YES]}, 1, 0]}]}, 0]}
        all_answered = {"none": [checks, {"!": [{"var": ""}]}]}
        return {"if": [{">=": [yes_count, n]}, "approved", all_answered, "rejected", "pending"]}
    if strategy == "sum_under":
        limit = float("".join(ch for ch in str(r.get("limit", "")) if ch.isdigit() or ch == ".") or 0)
        limit = int(limit) if limit.is_integer() else limit
        s = {"var": "sum"}
        return {"if": [{"in": [s, [None, ""]]}, "pending", {"<": [s, limit]}, "approved", "rejected"]}
    raise GateError(f"unknown roll-up strategy {strategy!r}")


def lint(rule: Any, path: str = "$") -> List[str]:
    """Dialect check for any rule stored in a release (also rules typed by hand)."""
    problems: List[str] = []
    if isinstance(rule, list):
        for i, x in enumerate(rule):
            problems += lint(x, f"{path}[{i}]")
    elif isinstance(rule, dict):
        if len(rule) != 1:
            problems.append(f"{path}: an operation object must have exactly one key")
            return problems
        op, args = next(iter(rule.items()))
        if op not in ALLOWED_OPS:
            problems.append(f"{path}: operator {op!r} is not in {DIALECT}")
        # Each rule below closes a JS/Python divergence found by test/test_differential.py.
        if op in BINARY_OPS and not (isinstance(args, list) and len(args) == 2):
            problems.append(f"{path}: {op!r} takes exactly 2 arguments in {DIALECT}")
        if op in ("===", "!==") and isinstance(args, list) and len(args) == 2 and _mixes_bool_number(args):
            problems.append(f"{path}: {op!r} between a boolean and a number literal (Python treats 1 == True)")
        if op == "+":
            if not (isinstance(args, list) and len(args) == 2):
                problems.append(f"{path}: '+' takes exactly 2 arguments in {DIALECT}")
            elif any(isinstance(a, bool) or a is None or isinstance(a, str) for a in args):
                problems.append(f"{path}: '+' operands must be numbers or rules, not bool/null/string literals")
        if op == "reduce" and not (isinstance(args, list) and len(args) == 3 and _is_number(args[2])):
            problems.append(f"{path}: 'reduce' needs 3 arguments with a number literal as the initial value")
        if op == "in":
            hay = args[1] if isinstance(args, list) and len(args) > 1 else None
            if isinstance(hay, list) and any(isinstance(h, (bool, float)) for h in hay):
                problems.append(f"{path}: 'in' haystack literals must be strings, ints or null")
        problems += lint(args, f"{path}.{op}")
    elif isinstance(rule, float) and rule != rule:
        problems.append(f"{path}: NaN literal")
    return problems


def evaluate(rule: Any, facts: Dict[str, Any]) -> Any:
    if rule is None:
        return True
    return jsonLogic(rule, facts)


def check_gate(gate: Optional[Dict[str, Any]], facts: Dict[str, Any]) -> Tuple[bool, Optional[str], List[Dict[str, Any]]]:
    """-> (open, refusal_message_if_closed, unmet_conditions)."""
    rule = compile_gate(gate)
    if rule is None:
        return True, None, []
    is_open = bool(evaluate(rule, facts))
    unmet = [c for c in _conds(gate) if not evaluate(compile_condition(c), facts)]
    refusal = None if is_open else (gate.get("refusal_message") or gate.get("refusal") or "Locked.")
    return is_open, refusal, unmet


def rollup_verdict(rollup: Optional[Dict[str, Any]], checks: List[str], sum_value: Any = None) -> str:
    norm = [str(x).strip().lower() for x in checks]
    return evaluate(compile_rollup(rollup), {"checks": norm, "sum": sum_value})


def compile_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Everything the runtime evaluates, compiled once at publish time and stored with the release."""
    out: Dict[str, Any] = {"dialect": DIALECT, "modules": {}}
    for m in manifest.get("modules", []):
        stage_gates = {}
        for s in m.get("stages", []):
            g = s.get("gate")  # optional stage-level gate (G-A); not produced by v5 yet
            if g:
                stage_gates[str(s["order"])] = compile_gate(g)
        out["modules"][m["key"]] = {
            "entry_gate": compile_gate(m.get("entry_gate")),
            "rollup": compile_rollup(m.get("rollup")),
            "stage_gates": stage_gates,
        }
    return out
