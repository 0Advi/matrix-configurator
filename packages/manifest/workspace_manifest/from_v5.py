"""Convert a configurator-v5 manifest (``tenant_config_releases.schema_version = 'configurator-v5'``)
into ``workspace-manifest/1``.

Purpose: the migration path for releases already published in the sandbox, and an executable form of
``docs/manifest/MAPPING.md``. Behaviour is reproduced, not reinterpreted:

* stage tier chain — v5 ``approvers`` sorted executive < supervisor < business_admin (default
  ``["supervisor"]``), filtered by ``tiers.executive`` / ``tiers.business_admin_signoff``; the first tier
  submits, the rest approve (app runtime ``ModuleRuntime.chain``). Every approver may approve, send back
  and reject (as the runtime allows).
* free-text validation hints ('a · b · c', 'min X · max Y', regex, 'pdf · max 20MB') → typed validation.
* ``restricted_to: site_creator`` → ``submit.restricted_to: case_creator``; subject = ``site`` (the v5
  world only knows BD sites — made explicit here instead of assumed).
* outcomes: the v5 vocabulary, spaces replaced by ``_`` ('in progress' → 'in_progress').
* ``exit_signal`` → ``exit.on_complete``; ``exit.on_reject = 'rejected'`` when any approver exists.

Built-in modules are NOT converted: they have no stages the runtime ever ran. They are reported in
``report['builtins']`` with the template that replaces them (Task 4: ``templates/matrix-bd/<key>``);
gates that wait on them are kept and therefore flagged by the validator until the template is added
(``include_templates=...``).
"""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple

TIER_RANK = {"executive": 0, "supervisor": 1, "business_admin": 2}
V5_OUTCOMES = ["pending", "allocated", "in progress", "submitted", "rejected", "approved", "done", "skipped"]
OUTCOME_KIND = {"pending": "open", "allocated": "open", "in_progress": "progress", "submitted": "progress",
                "rejected": "negative", "approved": "positive", "done": "positive", "skipped": "neutral"}
BUILTIN_ALIAS = {"pex": "project_excellence"}
MIME = {"pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "image": "image/*"}
SEP = re.compile(r"\s*[·•|]\s*")          # commas are NOT separators: '25,00,000' is one number
CHOICE_SEP = re.compile(r"\s*[·•|,]\s*")   # …but they may separate choice options


def outcome_key(o: Optional[str]) -> Optional[str]:
    return None if o is None else str(o).strip().replace(" ", "_")


def _key(s: str) -> str:
    k = re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")
    if not k or not k[0].isalpha():
        k = "s_" + k
    return k[:39] if len(k) >= 2 else k + "_x"


def _number(tok: str) -> Optional[float]:
    t = tok.replace(",", "").replace("₹", "").strip()
    try:
        v = float(t)
        return int(v) if v.is_integer() else v
    except ValueError:
        return None


def convert_field(f: Dict[str, Any], notes: List[str]) -> Dict[str, Any]:
    kind, hint = f.get("kind"), f.get("validation")
    out: Dict[str, Any] = {"key": f["key"], "label": f.get("label") or f["key"], "required": bool(f.get("required"))}
    t = {"choice": "choice", "yesno": "yes_no", "text": "text", "number": "number", "date": "date",
         "file": "file", "person": "person"}.get(kind, "text")
    out["type"] = t
    v: Dict[str, Any] = {}
    if hint:
        h = str(hint).strip()
        if t == "choice":
            opts = [o for o in CHOICE_SEP.split(h) if o]
            out["options"] = [{"value": _key(o) if not re.fullmatch(r"[a-z0-9_]+", o) else o, "label": o} for o in opts]
        elif t == "number":
            for tok in SEP.split(h):
                m = re.match(r"^(min|max)\s+(.+)$", tok, re.I)
                n = _number(m.group(2)) if m else None
                if m and n is not None:
                    v[m.group(1).lower()] = n
                elif tok:
                    notes.append(f"field {f['key']}: number hint {tok!r} not machine-readable; kept as help")
                    out["help"] = h
        elif t == "file":
            for tok in SEP.split(h):
                m = re.match(r"^max\s+([0-9.]+)\s*mb$", tok, re.I)
                if m:
                    v["max_size_mb"] = float(m.group(1)) if "." in m.group(1) else int(m.group(1))
                elif tok.lower() in MIME:
                    v.setdefault("accept", []).append(MIME[tok.lower()])
                elif tok:
                    notes.append(f"field {f['key']}: file hint {tok!r} not machine-readable; kept as help")
                    out["help"] = h
        elif t == "text":
            try:
                re.compile(h)
                v["pattern"] = h if h.startswith("^") or h.endswith("$") else h
            except re.error:
                out["help"] = h
        else:
            out["help"] = h
    elif t == "choice":
        out["options"] = [{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}]
        notes.append(f"field {f['key']}: choice without options; defaulted to yes/no")
    if v:
        out["validation"] = v
    if f.get("affects_outcome"):
        out["affects_outcome"] = True
    return out


def chain(stage: Dict[str, Any], tiers: Dict[str, Any]) -> List[str]:
    roles = sorted(set(stage.get("approvers") or ["supervisor"]), key=lambda r: TIER_RANK.get(r, 1))
    if tiers.get("business_admin_signoff") is False:
        roles = [r for r in roles if r != "business_admin"] or ["supervisor"]
    if tiers.get("executive") is False:
        roles = [r for r in roles if r != "executive"] or ["supervisor"]
    return roles


def _gate(g: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(g, dict):
        return None
    conds = []
    for c in g.get("conditions", g.get("conds")) or []:
        src = BUILTIN_ALIAS.get(c.get("source", c.get("src")), c.get("source", c.get("src")))
        if "stage" in c:
            conds.append({"source": src, "stage": f"s{c['stage']}" if isinstance(c["stage"], int) else str(c["stage"])})
        else:
            conds.append({"source": src, "outcome": outcome_key(c.get("outcome", c.get("out")))})
    if not conds:
        return None
    return {"match": g.get("match", "all"), "conditions": conds,
            "refusal_message": g.get("refusal_message") or g.get("refusal") or "This step is locked."}


def convert_module(m: Dict[str, Any], notes: List[str]) -> Dict[str, Any]:
    tiers = m.get("tiers") or {}
    stages_in = sorted([s for s in m.get("stages") or [] if isinstance(s, dict)], key=lambda s: s.get("order", 0))
    stages, uses_reject = [], False
    for s in stages_in:
        ch = chain(s, tiers)
        st: Dict[str, Any] = {"key": f"s{s.get('order')}", "name": s.get("name") or f"Stage {s.get('order')}",
                              "submit": {"roles": [ch[0]]},
                              "outcome": outcome_key(s.get("outcome")) or "submitted",
                              "fields": [convert_field(f, notes) for f in s.get("fields") or [] if isinstance(f, dict)]}
        if s.get("restricted_to") == "site_creator":
            st["submit"]["restricted_to"] = "case_creator"
        if len(ch) > 1:
            st["approvals"] = [{"role": r} for r in ch[1:]]
            uses_reject = True
        g = _gate(s.get("gate"))
        if g:
            st["gate"] = g
        stages.append(st)
    members = ["supervisor"] + (["executive"] if tiers.get("executive", True) else [])
    out: Dict[str, Any] = {"key": m["key"], "name": m.get("name") or m["key"], "subject": "site",
                           "enabled": bool(m.get("enabled", True)), "members": members,
                           "delegation": bool(tiers.get("delegation", False)),
                           "entry_gate": _gate(m.get("entry_gate")), "stages": stages,
                           "exit": {"on_complete": outcome_key(m.get("exit_signal")) or "done"}}
    if uses_reject:
        out["exit"]["on_reject"] = "rejected"
    ru = m.get("rollup") or {}
    strategy = ru.get("strategy")
    scored = [f"{st['key']}.{f['key']}" for st in stages for f in st["fields"]
              if f.get("affects_outcome") and f["type"] in ("choice", "yes_no", "number", "money")]
    if strategy in ("all_positive", "any_negative", "count_at_least", "sum_under") and scored:
        r = {"strategy": strategy, "fields": scored, "positive": out["exit"]["on_complete"], "negative": "rejected"}
        if strategy == "count_at_least":
            r["n"] = int(_number(str(ru.get("n", 1))) or 1)
        if strategy == "sum_under":
            r["limit"] = _number(str(ru.get("limit", 0))) or 0
            r["fields"] = [x for x in scored if any(f["key"] == x.split(".")[1] and f["type"] in ("number", "money")
                                                    for st in stages for f in st["fields"])]
        out["rollup"] = r
        out["exit"].setdefault("on_reject", "rejected")
        for st in stages:  # fields the new roll-up cannot score lose the flag (the v5 runtime ignored them too)
            for f in st["fields"]:
                if f.get("affects_outcome") and f"{st['key']}.{f['key']}" not in r["fields"]:
                    f.pop("affects_outcome")
                    notes.append(f"field {st['key']}.{f['key']}: affects_outcome dropped ({f['type']} cannot be scored)")
    else:
        if strategy == "custom":
            notes.append(f"module {m['key']}: roll-up 'custom' (pending engineering) has no equivalent; needs an adapter computeOutcome hook")
        for st in stages:
            for f in st["fields"]:
                f.pop("affects_outcome", None)
    return out


def default_roles() -> List[Dict[str, Any]]:
    return [{"key": "workspace_admin", "name": "Workspace admin", "scope": "workspace", "rank": 100},
            {"key": "business_admin", "name": "Business admin", "scope": "workspace", "rank": 90},
            {"key": "supervisor", "name": "Supervisor", "scope": "module", "rank": 20},
            {"key": "executive", "name": "Executive", "scope": "module", "rank": 10},
            {"key": "observer", "name": "Observer", "scope": "workspace", "rank": 0, "read_only": True}]


def default_outcomes() -> List[Dict[str, Any]]:
    return [{"key": outcome_key(o), "label": o.capitalize(), "kind": OUTCOME_KIND[outcome_key(o)]} for o in V5_OUTCOMES]


def default_grants() -> List[Dict[str, Any]]:
    """The sandbox's fixed behaviour, written down as grants (see docs/rbac for the model)."""
    return [{"action": "edit_draft", "roles": ["workspace_admin"]},
            {"action": "publish_release", "roles": ["workspace_admin"]},
            {"action": "migrate_cases", "roles": ["workspace_admin"]},
            {"action": "manage_members", "roles": ["business_admin"]},
            {"action": "manage_views", "roles": ["business_admin"]},
            {"action": "assign_cases", "roles": ["supervisor", "business_admin"]},
            {"action": "view_all_cases", "roles": ["business_admin", "observer", "supervisor"]},
            {"action": "override_step", "roles": ["business_admin"]},
            {"action": "view_audit", "roles": ["business_admin", "observer"]}]


def convert(v5: Dict[str, Any], *, include_templates: Optional[Dict[str, Dict[str, Any]]] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """-> (workspace-manifest/1, report). ``include_templates``: {builtin key: module from a template}."""
    notes: List[str] = []
    builtins: List[Dict[str, Any]] = []
    modules: List[Dict[str, Any]] = []
    for m in v5.get("modules") or []:
        if not isinstance(m, dict) or not m.get("key"):
            continue
        if m.get("type") == "builtin":
            key = BUILTIN_ALIAS.get(m["key"], m["key"])
            builtins.append({"key": key, "enabled": bool(m.get("enabled", True)), "template": f"templates/matrix-bd/{key}"})
            if include_templates and key in include_templates:
                mod = copy.deepcopy(include_templates[key])
                mod["enabled"] = bool(m.get("enabled", True))
                if m.get("name"):
                    mod["name"] = m["name"]
                modules.append(mod)
            continue
        modules.append(convert_module(m, notes))
    ws = v5.get("workspace") or {}
    slug = ws.get("slug") or _key(ws.get("id") or "workspace").replace("_", "-")
    out = {"format": "workspace-manifest/1",
           "workspace": {"key": slug if re.fullmatch(r"[a-z][a-z0-9-]{1,40}", slug) else "workspace",
                         "name": ws.get("name") or "Workspace"},
           "subjects": [{"key": "site", "label": "Site", "plural": "Sites"}],
           "roles": default_roles(), "outcomes": default_outcomes(),
           "signals": [{"key": s["key"], "label": s["key"], "subject": "site",
                        "outcomes": [outcome_key(o) for o in s.get("outcomes") or []]}
                       for s in v5.get("signals") or [] if isinstance(s, dict) and s.get("outcomes")],
           "modules": modules, "permissions": default_grants()}
    return out, {"builtins": builtins, "notes": notes,
                 "source": {"schema_version": "configurator-v5", "workspace_id": ws.get("id")}}
