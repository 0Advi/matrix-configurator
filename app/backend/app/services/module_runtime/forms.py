"""Stage field definitions -> JSON Schema (draft-07) + rjsf uiSchema.

First-party glue. The configurator's fields are ``{key, label, kind, required, validation, affects_outcome}``
with ``kind`` in choice | yesno | text | number | date | file | person and ``validation`` a free-text
hint (see building-blocks/from-design/vocabularies.json -> fieldValidationHints). This module turns them
into ONE JSON Schema that both sides use:

* frontend: ``@rjsf/core`` 6.11.0 renders it (``third_party/rjsf-check`` proves it on every real stage);
* backend:  ``jsonschema`` 4.26.0 validates submissions against the same schema (``validate_submission``).

Hints that are not machine-readable stay visible as help text and are listed in ``unparsed`` so the
configurator can raise a finding — they are the G-F gaps (conditionals, repeaters, uniqueness, …).
Compile once per stage at publish time and store the result with the release.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#"

_NUM = r"-?\d+(?:\.\d+)?"
_RANGE = re.compile(rf"^\s*({_NUM})\s*[–-]\s*({_NUM})\s*$")                  # "0–100", "0-10"
_MIN = re.compile(rf"\bmin\s+({_NUM})", re.I)
_MAX = re.compile(rf"\bmax\s+({_NUM})(?![\d.]|\s*[kmg]?b\b)", re.I)          # not "max 20MB"
_FILE_MAX = re.compile(r"(?:max|≤)\s*(\d+(?:\.\d+)?)\s*([kmg]b)", re.I)
_FILE_TYPES = re.compile(r"\b(pdf|png|jpe?g|docx?|xlsx?|csv)\b", re.I)


def _num(s: str):
    f = float(s)
    return int(f) if f.is_integer() else f


def _choice_options(hint: str) -> Optional[List[str]]:
    if not hint:
        return None
    sep = "·" if "·" in hint else ("," if "," in hint else None)
    if not sep:
        return None
    opts = [o.strip() for o in hint.split(sep) if o.strip()]
    return opts if len(opts) >= 2 else None


def field_schema(f: Dict[str, Any], file_mode: str = "data-url") -> Dict[str, Any]:
    """-> {"schema": {...}, "ui": {...}, "parsed": bool}. file_mode: 'data-url' (rjsf default widget) | 'ref'."""
    kind = f.get("kind", "text")
    hint = (f.get("validation") or "").strip()
    s: Dict[str, Any] = {"title": f.get("label") or f["key"]}
    ui: Dict[str, Any] = {}
    parsed = not hint or hint == "—"

    if kind == "choice":
        opts = _choice_options(hint)
        s["type"] = "string"
        if opts:
            s["enum"] = opts
            parsed = True
            ui["ui:widget"] = "radio" if len(opts) <= 3 else "select"
    elif kind == "yesno":
        s["type"] = "boolean"
        ui["ui:widget"] = "radio"
    elif kind == "number":
        s["type"] = "number"
        m = _RANGE.match(hint)
        if m:
            s["minimum"], s["maximum"] = _num(m.group(1)), _num(m.group(2))
            parsed = True
        else:
            lo, hi = _MIN.search(hint), _MAX.search(hint)
            if lo:
                s["minimum"] = _num(lo.group(1))
            if hi:
                s["maximum"] = _num(hi.group(1))
            if lo or hi:
                parsed = True
            if "₹" in hint:
                ui["ui:options"] = {"prefix": "₹"}
                parsed = parsed or hint.strip() in ("₹", "₹ per month")
    elif kind == "date":
        s["type"] = "string"
        s["format"] = "date"
    elif kind == "file":
        s["type"] = "string"
        if file_mode == "data-url":
            s["format"] = "data-url"
        else:
            ui["ui:widget"] = "MatrixFileWidget"  # F4: uploads to the app's file store, value = file id
        types = sorted({t.lower().replace("jpg", "jpeg") for t in _FILE_TYPES.findall(hint)})
        size = _FILE_MAX.search(hint)
        if types or size:
            ui["ui:options"] = {k: v for k, v in (("accept", ",".join("." + t for t in types) or None),
                                                  ("maxSize", size and f"{size.group(1)}{size.group(2).upper()}")) if v}
            parsed = True
    elif kind == "person":
        s["type"] = "string"
        ui["ui:widget"] = "MatrixPersonWidget"  # F4: user picker; hint = tier filter
        if hint:
            ui["ui:options"] = {"tier": hint}
            parsed = True
    else:  # text and anything unknown
        s["type"] = "string"
        if hint.startswith("^"):
            try:
                re.compile(hint)
                s["pattern"] = hint
                parsed = True
            except re.error:
                pass
    if hint and not parsed:
        s["description"] = hint
    elif hint and kind in ("number", "file") and "description" not in s:
        s["description"] = hint
    return {"schema": s, "ui": ui, "parsed": parsed}


def stage_form(stage: Dict[str, Any], file_mode: str = "data-url") -> Dict[str, Any]:
    """One stage -> {schema, uiSchema, rollupFields, unparsed}."""
    props: Dict[str, Any] = {}
    ui: Dict[str, Any] = {"ui:order": []}
    required: List[str] = []
    unparsed: List[Dict[str, str]] = []
    rollup_fields: List[str] = []
    for f in stage.get("fields", []):
        fs = field_schema(f, file_mode)
        props[f["key"]] = fs["schema"]
        if fs["ui"]:
            ui[f["key"]] = fs["ui"]
        ui["ui:order"].append(f["key"])
        if f.get("required"):
            required.append(f["key"])
        if f.get("affects_outcome"):
            rollup_fields.append(f["key"])
        if not fs["parsed"]:
            unparsed.append({"field": f["key"], "kind": f.get("kind", ""), "hint": f.get("validation") or ""})
    schema: Dict[str, Any] = {"$schema": SCHEMA_DRAFT, "type": "object", "title": stage.get("name", ""),
                              "properties": props, "additionalProperties": False}
    if required:
        schema["required"] = required
    return {"schema": schema, "uiSchema": ui, "rollupFields": rollup_fields, "unparsed": unparsed}


def rollup_checks(stage_form_result: Dict[str, Any], values: Dict[str, Any]) -> List[str]:
    """Normalise the outcome-affecting answers for gates.rollup_verdict (booleans -> yes/no)."""
    out = []
    for k in stage_form_result["rollupFields"]:
        v = values.get(k)
        out.append("yes" if v is True else "no" if v is False else "" if v is None else str(v))
    return out


def validate_submission(schema: Dict[str, Any], values: Dict[str, Any]) -> List[str]:
    """Backend validation with jsonschema 4.26.0 (MIT). Returns human-readable errors ([] = valid)."""
    import jsonschema  # pinned in the app backend: jsonschema==4.26.0

    validator = jsonschema.Draft7Validator(schema, format_checker=jsonschema.Draft7Validator.FORMAT_CHECKER)
    return sorted(f"{'/'.join(map(str, e.path)) or '(form)'}: {e.message}" for e in validator.iter_errors(values))
