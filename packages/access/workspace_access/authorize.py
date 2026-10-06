"""``authorize(principal, action, resource, policy)`` — the only access decision in the platform (Task 6).

Rules (docs/rbac/README.md §3 has the prose; every rule has a test):

  read-only roles and inactive principals never write; a disabled module is closed for everyone;
  stage actions:   the CURRENT step's actor role (submit roles / approval tier role, possibly borrowed from another
                   module) held by the principal + restriction (case/subject creator, assignee) + separation of
                   duties + the tier's allowed actions; otherwise an ``override_step`` grant → allowed AS OVERRIDE;
  case.view:       ``view_all_cases`` grant, or a member role's visibility (all / own / actionable), or being able
                   to act now; "view as" can only narrow;
  case.assign:     module delegation on + ``assign_cases`` grant;
  members.manage:  ``manage_members`` grant on the module + the role is in ``can_grant``;
  workspace work:  draft.edit / release.publish / cases.migrate / audit.view / workspace.manage via grants;
                   the platform operator may do these (platform policy), never case actions.

Policies passed in must be compiled from the RIGHT release: the case's pinned release for case.view/stage.*/
case.assign; the live release for everything else.
"""
from __future__ import annotations

from typing import Optional

from .model import (CASE_ACTIONS, DECISION_ACTION, GRANT_FOR, WORKSPACE_ACTIONS, WRITE_ACTIONS, CaseResource, Decision,
                    MemberResource, ModulePolicy, Policy, Principal, Resource)

OPEN_STATES = ("open", "in_progress")


def _grant(p: Principal, policy: Policy, grant_action: str, module: Optional[str]):
    """The first grant of ``grant_action`` the principal holds for ``module`` (None = workspace-level)."""
    for g in policy.grants_for(grant_action):
        if g.modules is not None and module not in g.modules:
            continue
        for role in g.roles:
            if policy.roles.get(role, {}).get("read_only") and grant_action not in ("view_all_cases", "view_audit"):
                continue
            if p.holds(role, module, policy):
                return g, role
            # a module-scope holder of a workspace-level grant (no module given) holds it via any membership
            if module is None and policy.roles.get(role, {}).get("scope") == "module" and any(r == role for _, r in p.memberships):
                return g, role
    return None, None


def _is_read_only(p: Principal, policy: Policy) -> bool:
    held = set(p.workspace_roles) | {r for _, r in p.memberships}
    return bool(held) and all(policy.roles.get(r, {}).get("read_only") for r in held)


def _step_actor(p: Principal, policy: Policy, mod: ModulePolicy, res: CaseResource, action: str):
    """→ (matched_role, why_not) for the current step of the case."""
    st = mod.stage(res.stage or "")
    if st is None:
        return None, ("bad_stage", f"stage {res.stage!r} is not in release v{policy.release_version}")
    if res.step == 0:
        if action != "stage.submit":
            return None, ("wrong_step", f"stage {st.key!r} is waiting for a submission, not a decision")
        roles, src, step_name = st.submit_roles, st.submit_module or mod.key, "submit"
        allowed_actions = ("submit",)
    else:
        if res.step > len(st.approvals):
            return None, ("bad_step", f"stage {st.key!r} has {len(st.approvals)} approval tier(s)")
        role, borrowed, allowed_actions = st.approvals[res.step - 1]
        if action == "stage.submit":
            return None, ("wrong_step", f"stage {st.key!r} is waiting for approval tier {res.step}")
        if DECISION_ACTION[action] not in allowed_actions:
            return None, ("action_not_allowed", f"tier {res.step} of {st.key!r} may {list(allowed_actions)}, not {DECISION_ACTION[action]}")
        roles, src, step_name = (role,), borrowed or mod.key, f"approval tier {res.step}"
    held = [r for r in roles if p.holds(r, src, policy)]
    if not held:
        where = f" of module {src!r}" if src != mod.key else ""
        return None, ("not_actor", f"{step_name} of {st.key!r} needs one of {list(roles)}{where}")
    if res.step == 0 and st.restricted_to:
        bound = [r for r in held if r in st.restrict_roles]
        free = [r for r in held if r not in st.restrict_roles]
        if not free:
            who = {"case_creator": res.created_by, "subject_creator": res.subject_created_by, "assignee": res.assigned_to}[st.restricted_to]
            if who != p.user_id:
                return None, (f"restricted_{st.restricted_to}", f"only the {st.restricted_to.replace('_', ' ')} may submit {st.key!r}")
        held = free or bound
    if mod.separation_of_duties and p.user_id in res.acted_in_pass:
        return None, ("separation_of_duties", "you already acted on this stage pass")
    return f"stage {st.key} {step_name}: {held[0]}" + (f" (from {src})" if src != mod.key else ""), None


def _can_act_now(p: Principal, policy: Policy, mod: ModulePolicy, res: CaseResource) -> bool:
    if res.status not in OPEN_STATES:
        return False
    actions = ("stage.submit",) if res.step == 0 else ("stage.approve", "stage.reject", "stage.send_back")
    return any(_step_actor(p, policy, mod, res, a)[0] for a in actions)


def _view_case(p: Principal, policy: Policy, mod: ModulePolicy, res: CaseResource) -> Decision:
    rv = policy.release_version
    g, role = _grant(p, policy, "view_all_cases", mod.key)
    if g:
        return Decision.allow(f"grant view_all_cases: {role}", rv)
    mine = p.user_id in {res.created_by, res.assigned_to, res.subject_created_by} | set(res.participants)
    for role in sorted(p.module_roles(mod.key)):
        level = mod.visibility.get(role, "own")
        if level == "all":
            return Decision.allow(f"visibility {role}=all", rv)
        if level == "own" and mine:
            return Decision.allow(f"visibility {role}=own", rv)
    if _can_act_now(p, policy, mod, res):
        return Decision.allow("can act on the current step", rv)
    return Decision.deny("not_visible", "this case is outside what your roles can see", rv)


def _narrow_view_as(p: Principal, policy: Policy, action: str, res: Resource, real: Decision) -> Decision:
    """'View as': a second decision for a principal holding ONLY the simulated role; both must allow."""
    if not real.allowed or not p.view_as or action not in ("case.view", "module.view"):
        return real
    r = policy.roles.get(p.view_as)
    if r is None:
        return Decision.deny("unknown_role", f"cannot view as unknown role {p.view_as!r}", policy.release_version)
    mods = frozenset(policy.modules)
    sim = Principal(p.user_id, workspace_roles=frozenset({p.view_as}) if r["scope"] == "workspace" else frozenset(),
                    memberships=frozenset((m, p.view_as) for m in mods) if r["scope"] == "module" else frozenset())
    simulated = authorize(sim, action, res, policy)
    return real if simulated.allowed else Decision.deny("view_as_narrowed", f"not visible to a {p.view_as}", policy.release_version)


def authorize(p: Principal, action: str, res: Resource, policy: Policy) -> Decision:
    rv = policy.release_version
    if not p.active:
        return Decision.deny("inactive", "account is inactive", rv)
    if action in WRITE_ACTIONS and _is_read_only(p, policy) and not p.platform_operator:
        return Decision.deny("read_only", "your roles are read-only", rv)

    # ── workspace-level ───────────────────────────────────────────────────────────────
    if action in WORKSPACE_ACTIONS:
        if p.platform_operator:
            return Decision.allow("platform operator", rv)
        g, role = _grant(p, policy, GRANT_FOR[action], None)
        return Decision.allow(f"grant {g.action}: {role}", rv) if g else Decision.deny("not_granted", f"{action} needs the {GRANT_FOR[action]} grant", rv)

    mod = policy.modules.get(res.module or "")
    if mod is None:
        return Decision.deny("unknown_module", f"module {res.module!r} is not in release v{rv}", rv)
    if not mod.enabled:
        return Decision.deny("module_disabled", f"module {mod.key!r} is disabled", rv)
    if p.platform_operator and action in CASE_ACTIONS + ("case.open",):
        return Decision.deny("platform_operator", "the platform operator does not work cases", rv)

    if action == "module.view":
        if p.module_roles(mod.key) or _grant(p, policy, "view_all_cases", mod.key)[0]:
            return _narrow_view_as(p, policy, action, res, Decision.allow("member or view_all_cases", rv))
        for st in mod.stages:
            pairs = [(r, st.submit_module or mod.key) for r in st.submit_roles] + [(r, b or mod.key) for r, b, _ in st.approvals]
            if any(p.holds(r, src, policy) for r, src in pairs):
                return _narrow_view_as(p, policy, action, res, Decision.allow(f"actor in stage {st.key}", rv))
        return Decision.deny("not_member", f"you have no role in {mod.key!r}", rv)

    if action == "case.open":
        first = mod.stages[0]
        if any(p.holds(r, first.submit_module or mod.key, policy) for r in first.submit_roles):
            if first.restricted_to == "subject_creator" and not set(first.submit_roles) - set(first.restrict_roles):
                sc = getattr(res, "subject_created_by", None)
                if sc is not None and sc != p.user_id:
                    return Decision.deny("restricted_subject_creator", "only the subject's creator may open this module", rv)
            return Decision.allow(f"submitter of {first.key}", rv)
        g, role = _grant(p, policy, "override_step", mod.key)
        return Decision.allow(f"grant override_step: {role}", rv, override=True) if g else \
            Decision.deny("not_actor", f"opening needs a submitter role of {first.key!r}", rv)

    if action == "views.manage":
        g, role = _grant(p, policy, "manage_views", mod.key)
        return Decision.allow(f"grant manage_views: {role}", rv) if g else Decision.deny("not_granted", "needs manage_views", rv)

    if action == "members.manage":
        target = res.role if isinstance(res, MemberResource) else ""
        for g in policy.grants_for("manage_members"):
            if g.modules is not None and mod.key not in g.modules:
                continue
            holder = next((r for r in g.roles if p.holds(r, mod.key, policy) and not policy.roles[r]["read_only"]), None)
            if not holder:
                continue
            allowed = g.can_grant if g.can_grant is not None else frozenset(r for r in mod.members)
            if target in allowed:
                return Decision.allow(f"grant manage_members: {holder} may grant {target}", rv)
        return Decision.deny("not_granted", f"you may not hand out {target!r} in {mod.key!r}", rv)

    # ── case-level ────────────────────────────────────────────────────────────────────
    if not isinstance(res, CaseResource):
        return Decision.deny("bad_resource", "case action without a case", rv)
    if action == "case.view":
        return _narrow_view_as(p, policy, action, res, _view_case(p, policy, mod, res))
    if res.status not in OPEN_STATES:
        return Decision.deny("closed", f"the case is {res.status}", rv)
    if action == "case.assign":
        if not mod.delegation:
            return Decision.deny("delegation_off", f"module {mod.key!r} does not assign cases", rv)
        g, role = _grant(p, policy, "assign_cases", mod.key)
        return Decision.allow(f"grant assign_cases: {role}", rv) if g else Decision.deny("not_granted", "needs assign_cases", rv)

    via, why = _step_actor(p, policy, mod, res, action)
    if via:
        return Decision.allow(via, rv)
    if why[0] in ("bad_stage", "bad_step", "wrong_step", "action_not_allowed"):
        return Decision.deny(why[0], why[1], rv)           # an override cannot change what the step is
    g, role = _grant(p, policy, "override_step", mod.key)
    if g:
        return Decision.allow(f"grant override_step: {role}", rv, override=True)
    return Decision.deny(why[0], why[1], rv)


def can_be_assigned(target: Principal, res: CaseResource, policy: Policy) -> Decision:
    """Target check for case.assign: the assignee must be able to work the current step (ignoring the assignee rule)."""
    mod = policy.modules.get(res.module or "")
    if mod is None:
        return Decision.deny("unknown_module", "unknown module", policy.release_version)
    probe = CaseResource(module=res.module, case_id=res.case_id, status=res.status, stage=res.stage, step=res.step,
                         created_by=res.created_by, subject_created_by=res.subject_created_by, assigned_to=target.user_id)
    acts = ("stage.submit",) if res.step == 0 else ("stage.approve", "stage.reject", "stage.send_back")
    for a in acts:
        via, why = _step_actor(target, policy, mod, probe, a)
        if via:
            return Decision.allow(f"assignee {via}", policy.release_version)
    return Decision.deny("not_assignable", "the assignee holds no actor role for the current step", policy.release_version)


def explain(d: Decision) -> dict:
    """Audit record for a decision: what matched (or why not), and under which release."""
    return {"allowed": d.allowed, "code": d.code, "reason": d.reason, "via": d.via, "as_override": d.as_override,
            "policy_release_version": d.release_version}
