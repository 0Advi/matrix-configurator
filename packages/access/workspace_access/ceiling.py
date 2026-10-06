"""Publish-time platform ceiling (Task 6): what a workspace may grant at all. Findings use the validator's shape."""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Mapping, Optional

DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "platform_ceiling.json")


def load_ceiling(path: Optional[str] = None) -> Dict[str, Any]:
    with open(path or DEFAULT, encoding="utf-8") as fh:
        return json.load(fh)


def check_ceiling(manifest: Mapping[str, Any], ceiling: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    ceiling = ceiling or load_ceiling()
    roles = {r.get("key"): r for r in manifest.get("roles", []) if isinstance(r, dict)}
    out: List[Dict[str, Any]] = []

    def err(code: str, msg: str, path: str) -> None:
        out.append({"severity": "error", "rule": "C1", "code": code, "message": msg, "path": path})

    for i, g in enumerate(manifest.get("permissions", []) or []):
        rule = ceiling["grants"].get(g.get("action"))
        if rule is None:
            err("ceiling_unknown_action", f"the platform does not allow granting {g.get('action')!r}", f"permissions/{i}")
            continue
        for role in g.get("roles", []):
            r = roles.get(role) or {}
            if r.get("scope") not in rule["holder_scopes"]:
                err("ceiling_scope", f"{g.get('action')} may only be held by {'/'.join(rule['holder_scopes'])}-scope roles; "
                                     f"{role!r} is {r.get('scope')}-scope", f"permissions/{i}/roles")
            if r.get("read_only") and not rule["read_only"]:
                err("ceiling_read_only", f"read-only role {role!r} cannot hold {g.get('action')}", f"permissions/{i}/roles")
            if rule.get("module_holders_need_modules") and r.get("scope") == "module" and not g.get("modules"):
                err("ceiling_unscoped", f"module-scope role {role!r} may hold {g.get('action')} only for listed modules",
                    f"permissions/{i}/modules")
    ws = sum(1 for r in roles.values() if r.get("scope") == "workspace")
    md = sum(1 for r in roles.values() if r.get("scope") == "module")
    if ws > ceiling["max_workspace_roles"] or md > ceiling["max_module_roles"]:
        err("ceiling_role_count", f"{ws} workspace / {md} module roles exceed the platform limit", "roles")
    return out
