"""Manifest-driven access control (Task 6): principal, compiled policy, resources, decisions.

Nothing here knows a role name. Roles, their scope, who acts on which step, who sees what and who may grant
what all come from a release's ``workspace-manifest/1``; the platform adds only a ceiling (what a workspace may
grant at all) and the platform-operator principal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Tuple

# ─────────────────────────────────────────────────────────────────────────────── actions ──
WORKSPACE_ACTIONS = ("draft.edit", "release.publish", "cases.migrate", "audit.view", "workspace.manage")
MODULE_ACTIONS = ("module.view", "case.open", "views.manage", "members.manage")
CASE_ACTIONS = ("case.view", "stage.submit", "stage.approve", "stage.reject", "stage.send_back", "case.assign")
ACTIONS = WORKSPACE_ACTIONS + MODULE_ACTIONS + CASE_ACTIONS
WRITE_ACTIONS = frozenset(ACTIONS) - {"module.view", "case.view", "audit.view"}

# manifest grant action  →  the authorize() actions it unlocks
GRANT_FOR = {"draft.edit": "edit_draft", "release.publish": "publish_release", "cases.migrate": "migrate_cases",
             "audit.view": "view_audit", "workspace.manage": "manage_workspace", "views.manage": "manage_views",
             "members.manage": "manage_members", "case.assign": "assign_cases"}
DECISION_ACTION = {"stage.approve": "approve", "stage.reject": "reject", "stage.send_back": "send_back"}


# ───────────────────────────────────────────────────────────────────────────── principal ──
@dataclass(frozen=True)
class Principal:
    """Who is asking. Loaded from the DB on every request — the token carries identity only."""
    user_id: str
    workspace_roles: FrozenSet[str] = frozenset()                 # workspace-scope roles held
    memberships: FrozenSet[Tuple[str, str]] = frozenset()         # (module_key, module-scope role) — any number
    platform_operator: bool = False                               # the platform's own operator (not a workspace role)
    view_as: Optional[str] = None                                 # "view as" a role: narrows reads, never affects writes
    active: bool = True

    def holds(self, role: str, module: Optional[str], policy: "Policy") -> bool:
        r = policy.roles.get(role)
        if r is None:
            return False
        if r["scope"] == "workspace":
            return role in self.workspace_roles
        return module is not None and (module, role) in self.memberships

    def module_roles(self, module: str) -> FrozenSet[str]:
        return frozenset(r for m, r in self.memberships if m == module)


# ─────────────────────────────────────────────────────────────────────────────── policy ──
@dataclass(frozen=True)
class StagePolicy:
    key: str
    index: int
    submit_roles: Tuple[str, ...]
    submit_module: Optional[str]
    restricted_to: Optional[str]
    restrict_roles: Tuple[str, ...]
    approvals: Tuple[Tuple[str, Optional[str], Tuple[str, ...]], ...]   # (role, borrowed module, actions)


@dataclass(frozen=True)
class ModulePolicy:
    key: str
    enabled: bool
    members: Tuple[str, ...]
    delegation: bool
    separation_of_duties: bool
    visibility: Mapping[str, str]                 # member role → all | own | actionable (defaults filled in)
    stages: Tuple[StagePolicy, ...]

    def stage(self, key: str) -> Optional[StagePolicy]:
        return next((s for s in self.stages if s.key == key), None)


@dataclass(frozen=True)
class Grant:
    action: str
    roles: FrozenSet[str]
    modules: Optional[FrozenSet[str]]             # None = every module
    can_grant: Optional[FrozenSet[str]]


@dataclass(frozen=True)
class Policy:
    release_version: int
    roles: Mapping[str, Mapping[str, Any]]        # key → {scope, read_only}
    modules: Mapping[str, ModulePolicy]
    grants: Tuple[Grant, ...]

    def grants_for(self, action: str) -> List[Grant]:
        return [g for g in self.grants if g.action == action]


# ───────────────────────────────────────────────────────────────────────────── resources ──
@dataclass(frozen=True)
class Resource:
    module: Optional[str] = None


@dataclass(frozen=True)
class CaseResource(Resource):
    """What the guard needs to know about a case (loaded by the runtime; never from the client)."""
    case_id: str = ""
    status: str = "open"                          # open | in_progress | completed | rejected | parked
    stage: Optional[str] = None                   # current stage key
    step: int = 0                                 # 0 = submit step; k ≥ 1 = approval tier k
    created_by: Optional[str] = None
    subject_created_by: Optional[str] = None
    assigned_to: Optional[str] = None
    acted_in_pass: FrozenSet[str] = frozenset()   # users who acted on this stage pass (separation of duties)
    participants: FrozenSet[str] = frozenset()    # everyone who ever acted on the case


@dataclass(frozen=True)
class MemberResource(Resource):
    role: str = ""                                # the role being handed out / revoked


# ─────────────────────────────────────────────────────────────────────────────── decision ──
@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str                                     # ok | override | not_member | wrong_step | ... (see docs/rbac)
    reason: str
    as_override: bool = False
    via: Optional[str] = None                     # what matched: "stage plan submit: executive", "grant view_all_cases", …
    release_version: Optional[int] = None

    @staticmethod
    def allow(via: str, rv: int, override: bool = False) -> "Decision":
        return Decision(True, "override" if override else "ok", "allowed", override, via, rv)

    @staticmethod
    def deny(code: str, reason: str, rv: Optional[int]) -> "Decision":
        return Decision(False, code, reason, False, None, rv)


def compile_policy(manifest: Mapping[str, Any], release_version: int) -> Policy:
    """Release manifest → Policy. Releases are immutable, so callers cache this per release id."""
    roles = {r["key"]: {"scope": r["scope"], "read_only": bool(r.get("read_only"))} for r in manifest.get("roles", [])}
    modules = {}
    for m in manifest.get("modules", []):
        stages = []
        tier_roles = set()
        for i, s in enumerate(m.get("stages", [])):
            sub = s.get("submit", {})
            appr = tuple((a["role"], a.get("module"), tuple(a.get("actions", ("approve", "reject", "send_back"))))
                         for a in s.get("approvals", []))
            tier_roles |= {r for r, mod, _ in appr if mod is None}
            stages.append(StagePolicy(s["key"], i, tuple(sub.get("roles", ())), sub.get("module"), sub.get("restricted_to"),
                                      tuple(sub.get("restrict_roles", sub.get("roles", ()))), appr))
        vis = {r: ("all" if r in tier_roles else "own") for r in m.get("members", [])}
        vis.update(m.get("visibility") or {})
        modules[m["key"]] = ModulePolicy(m["key"], m.get("enabled", True) is not False, tuple(m.get("members", ())),
                                         bool(m.get("delegation")), m.get("separation_of_duties", True) is not False,
                                         vis, tuple(stages))
    grants = tuple(Grant(g["action"], frozenset(g["roles"]), frozenset(g["modules"]) if g.get("modules") else None,
                         frozenset(g["can_grant"]) if g.get("can_grant") else None) for g in manifest.get("permissions", []))
    return Policy(release_version, roles, modules, grants)
