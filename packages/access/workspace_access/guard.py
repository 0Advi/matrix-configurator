"""Backend guard (Task 6): the one dependency every route uses instead of require_role / require_module.

    guard = Guard(load_principal=..., load_release=..., load_case=...)
    decision = guard.check(user_id, workspace_id, "stage.approve", case_id=..., view_as=request header X-View-As)

* the principal is read from the DB on EVERY request (``access_principal``) — the token carries identity only;
* the policy comes from the RIGHT release: the case's PINNED release for case actions, the live release otherwise;
* compiled policies are cached per immutable release id (a release never changes, so the cache never goes stale);
* a denial raises ``AccessDenied`` whose ``problem()`` is an RFC 9457 problem+json body with the decision code;
* every allowed override and every denial is handed to ``audit`` with ``explain(decision)``.

Framework-free on purpose: a FastAPI dependency is a three-line wrapper (docs/rbac/README.md §6).
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from .authorize import authorize, explain
from .model import CASE_ACTIONS, CaseResource, Decision, MemberResource, Policy, Principal, Resource, compile_policy

Release = Tuple[str, int, Mapping[str, Any]]          # (release id, version, manifest)


class AccessDenied(Exception):
    def __init__(self, decision: Decision, action: str):
        super().__init__(f"{decision.code}: {decision.reason}")
        self.decision, self.action = decision, action

    def problem(self) -> Dict[str, Any]:
        d = self.decision
        return {"type": f"https://errors.workspace.dev/access/{d.code}", "title": "Not allowed", "status": 403,
                "code": d.code, "detail": d.reason, "action": self.action, "release_version": d.release_version}


class PolicyCache:
    """LRU of compiled policies keyed by release id. Releases are immutable, so entries never go stale."""

    def __init__(self, size: int = 64):
        self.size, self._d = size, OrderedDict()
        self.compiles = 0

    def get(self, release: Release) -> Policy:
        rid, version, manifest = release
        if rid in self._d:
            self._d.move_to_end(rid)
            return self._d[rid]
        self.compiles += 1
        pol = self._d[rid] = compile_policy(manifest, version)
        if len(self._d) > self.size:
            self._d.popitem(last=False)
        return pol


class Guard:
    def __init__(self, load_principal: Callable[[str, str], Principal],
                 load_live_release: Callable[[str], Release],
                 load_case: Callable[[str, str], Tuple[CaseResource, Release]],
                 audit: Callable[[str, str, Dict[str, Any]], None] = lambda *a: None,
                 cache: Optional[PolicyCache] = None):
        self.load_principal, self.load_live_release, self.load_case = load_principal, load_live_release, load_case
        self.audit, self.cache = audit, cache or PolicyCache()

    def check(self, user_id: str, workspace_id: str, action: str, *, case_id: Optional[str] = None,
              module: Optional[str] = None, member_role: Optional[str] = None, view_as: Optional[str] = None) -> Decision:
        p = self.load_principal(workspace_id, user_id)
        if view_as:
            p = Principal(p.user_id, p.workspace_roles, p.memberships, p.platform_operator, view_as, p.active)
        if action in CASE_ACTIONS:
            if case_id is None:
                raise ValueError(f"{action} needs case_id")
            res, release = self.load_case(workspace_id, case_id)          # the case's PINNED release
        else:
            release = self.load_live_release(workspace_id)
            res = MemberResource(module=module, role=member_role or "") if action == "members.manage" else Resource(module=module)
        d = authorize(p, action, res, self.cache.get(release))
        if d.as_override or not d.allowed:
            self.audit(user_id, action, {**explain(d), "case_id": case_id, "module": res.module})
        if not d.allowed:
            raise AccessDenied(d, action)
        return d
