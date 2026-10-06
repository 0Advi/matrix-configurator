"""Generic custom-module runtime service (Phase 2, decision D4).

Runs every CUSTOM module of a tenant's published configuration on F3's interpreter
(services/module_runtime/runtime.py) and persists it onto F2's tables:

    module_records       one case per (site, module): status / current_stage / exit_outcome +
                         ``runtime_state`` (the interpreter state, incl. its audit hash-chain head)
    module_stage_states  per stage: status + field values (+ submitted_by/at, decided_at)
    module_approvals     APPEND-ONLY tier decisions, ``is_override`` = the runtime's admin-override flag
    audit_logs           EVERY runtime event, with config_release_id, module_key and provenance
                         {"policy", "release_version", "event": <the hash-chained event>, ...}

Rules (F2/F3 rulings, see docs/F4-API.md):
  * a case runs on the release its SITE is pinned to (sites.config_release_id; a legacy site
    with no pin takes the live release and the record pins it) — never re-read from the live one;
  * the interpreter is built with its default ``admin_override=True``: a business admin may act
    on any step; when that is outside the stage's tier chain the event carries override=true and
    the approval row ``is_override=true`` (the DB guard accepts it only then);
  * a business admin's form submission is recorded as verdict ``submitted`` (F3's approval_row
    rewrite to ``approved`` is undone: F2's guard accepts submitted from the chain's first tier);
  * gate facts: ``reached`` = site_module_outcomes.reached (cumulative, built-in + custom; built-ins
    also under their configurator alias, e.g. pex), ``stages``/``fields`` from custom cases;
  * every command = one transaction with the module_records row locked (FOR UPDATE).
Who may act: business_admin (any step, override-flagged when outside the chain), members of the
module (user_module_memberships.role_in_module) in their tier, observers read only. Tenant always
comes from the verified token.

Phase 2b (G3):
  * creator-scoped stages (``restricted_to: "site_creator"``, see runtime.py): the actor carries
    ``owned_sites`` (sites it submitted or is the BD assignee of — the real app's owns()); the
    runtime refuses non-owners with 403 ``not_site_creator`` (a business admin acts as a flagged
    override, provenance ``creator_override``); an executive also SEES the cases of a module with
    a creator-scoped stage on sites it owns (lists + detail);
  * ``GET /m/{key}/records?view=<id>`` applies a saved view (module_views_service) AFTER the scope.

Phase 2c (F5a):
  * scope + saved views follow the EFFECTIVE role after X-Override-Role (``view_role``); acting keeps
    the REAL role (``_actor_role``) — core/deps.py semantics, G2's E3;
  * files for ``kind: file`` fields: ``svc_upload_file`` (current form step only, by whoever may
    submit it; size/type from the field's validation hint capped by MAX_UPLOAD_BYTES and the app's
    MIME allowlist + magic bytes; bytes in the app's storage bucket, metadata in ``module_files``,
    migration 20261006_1), ``svc_get_file`` (short-lived signed URL, same visibility as the case);
    a submitted file-field value must be the id of a file uploaded for THIS record, stage and field.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
import uuid
from collections import OrderedDict
from typing import Any, Optional
from uuid import UUID

from fastapi import HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.problems import ApiProblem
from app.core.uploads import read_upload_capped
from app.db.session import transaction
from app.services import module_registry_service as registry
from app.services.audit_service import write_provenance_audit
from app.services import module_views_service as views_svc
from app.services.module_runtime import forms, runtime
from app.services import storage_service

logger = logging.getLogger("matrix.module_runtime")

# Refusal.code -> HTTP status (F3 for-F4 §1).
_REFUSAL_STATUS = {
    "wrong_tier": 403, "no_delegation": 403, "observer_read_only": 403, "separation_of_duties": 403,
    "not_site_creator": 403,
    "gate_closed": 409, "stage_gate_closed": 409, "release_mismatch": 409, "closed": 409,
    "wrong_action": 409, "nothing_to_send_back": 409,
    "invalid_form": 422, "reason_required": 422, "bad_target": 422, "unknown_action": 422,
}


# ── release + interpreter cache (releases are immutable) ──────────────────────

_CACHE_LOCK = threading.Lock()
_RELEASES: "OrderedDict[str, dict]" = OrderedDict()
_RUNTIMES: "OrderedDict[tuple, runtime.ModuleRuntime]" = OrderedDict()
_CACHE_MAX = 256


def _cache_put(cache: OrderedDict, key, value) -> None:
    with _CACHE_LOCK:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > _CACHE_MAX:
            cache.popitem(last=False)


async def load_release(session: AsyncSession, tenant_id: str | UUID, release_id: str | UUID) -> dict:
    """{id, tenant_id, version, manifest} of a release of THIS tenant (cached by id)."""
    key = str(release_id)
    rel = _RELEASES.get(key)
    if rel is None:
        row = (await session.execute(text("""
            SELECT id, tenant_id, version, manifest, manifest_sha256
              FROM tenant_config_releases WHERE id = :rid
        """), {"rid": key})).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Configuration release not found.")
        rel = {"id": str(row["id"]), "tenant_id": str(row["tenant_id"]), "version": row["version"],
               "manifest": row["manifest"], "manifest_sha256": row["manifest_sha256"]}
        _cache_put(_RELEASES, key, rel)
    if rel["tenant_id"] != str(tenant_id):
        raise HTTPException(status_code=404, detail="Configuration release not found.")
    return rel


def module_def(release: dict, module_key: str) -> Optional[dict]:
    """The CUSTOM module ``module_key`` of a release manifest (built-ins never run here)."""
    for m in release["manifest"].get("modules", []):
        if m.get("key") == module_key and m.get("type") != "builtin":
            return m
    return None


def runtime_for(release: dict, mdef: dict) -> runtime.ModuleRuntime:
    """The interpreter for (release, module), cached — releases are immutable."""
    key = (release["id"], mdef["key"])
    rt = _RUNTIMES.get(key)
    if rt is None:
        # default admin_override=True (F2 ruling): the DB records the override, never hides it.
        rt = runtime.ModuleRuntime(mdef, release=release["id"])
        _cache_put(_RUNTIMES, key, rt)
    return rt


# ── access ────────────────────────────────────────────────────────────────────

async def _custom_module(session: AsyncSession, tenant_id, module_key: str) -> dict:
    reg = await registry.get_tenant_module(session, tenant_id, module_key)
    if not reg or reg["kind"] != "custom":
        raise HTTPException(status_code=404, detail=f"No custom module '{module_key}' in this workspace.")
    if not reg["enabled"]:
        raise HTTPException(status_code=403, detail=f"Module '{module_key}' is disabled in this workspace.")
    return reg


_SIMULATABLE = ("supervisor", "executive")


async def _actor_role(session: AsyncSession, current_user: dict, tenant_id, reg: dict) -> str:
    """The AUTHORIZATION role in this module: who may act, and as which tier.

    business_admin | observer come from the REAL role (``real_role``), never from X-Override-Role —
    exactly core/deps.py: a business admin "simulating" an executive still acts as the business
    admin (override-flagged and recorded as such), an observer stays read-only. A member acts in
    their tier of the module; F5a: a dual-role supervisor (approved executive access in THIS
    module) who dropped to executive with X-Override-Role acts as an executive — deps.py's third
    override case (not an escalation: executive is below supervisor). Scope and saved views
    follow the EFFECTIVE role instead — see ``view_role``.
    """
    real_role = current_user.get("real_role") or current_user.get("role")
    if real_role in ("business_admin", "observer"):
        return real_role
    rows = (await session.execute(text("""
        SELECT role_in_module, COALESCE(has_executive_access, false) AS exec_access
          FROM user_module_memberships
         WHERE tenant_id = :tid AND user_id = :uid AND module = :m
    """), {"tid": tenant_id, "uid": current_user["sub"], "m": reg["module_key"]})).mappings().all()
    if not rows:
        raise HTTPException(status_code=403, detail=f"You are not a member of {reg['label']}.")
    if any(r["role_in_module"] == "supervisor" for r in rows):
        dropped = (current_user.get("role") or "").lower() == "executive"
        if dropped and any(r["role_in_module"] == "supervisor" and r["exec_access"] for r in rows):
            return "executive"
        return "supervisor"
    return "executive"


def view_role(current_user: dict, actor_role: str) -> str:
    """The SCOPE / VIEWS role (G2 E3, F5a): the EFFECTIVE role after X-Override-Role.

    A business admin or observer presenting as supervisor/executive (Workspace Access) sees the
    module in that role's shape — an executive's scope (cases they opened / are assigned /
    delegated / own), that role's saved views and default view — while ``_actor_role`` keeps the
    real role for anything security-relevant (acting, managing views, observer write denial).
    """
    eff = (current_user.get("role") or "").lower()
    if actor_role in ("business_admin", "observer") and eff in _SIMULATABLE:
        return eff
    return actor_role


async def _delegated_sites(session: AsyncSession, tenant_id, module_key: str, user_id) -> tuple[str, ...]:
    rows = (await session.execute(text("""
        SELECT site_id FROM site_delegations
         WHERE tenant_id = :tid AND module = :m AND delegate_user_id = :uid AND revoked_at IS NULL
        UNION
        SELECT site_id FROM module_records
         WHERE tenant_id = :tid AND module_key = :m AND assigned_to = :uid
    """), {"tid": tenant_id, "m": module_key, "uid": user_id})).scalars().all()
    return tuple(str(s) for s in rows)


async def _owned_sites(session: AsyncSession, tenant_id, module_key: str, user_id) -> tuple[str, ...]:
    """G3: sites with a case of this module that the user created or is the BD assignee of
    (sites.submitted_by / sites.assigned_to — the real app's owns(site, user))."""
    rows = (await session.execute(text("""
        SELECT DISTINCT r.site_id FROM module_records r JOIN sites s ON s.id = r.site_id
         WHERE r.tenant_id = :tid AND r.module_key = :m AND (s.submitted_by = :uid OR s.assigned_to = :uid)
    """), {"tid": tenant_id, "m": module_key, "uid": user_id})).scalars().all()
    return tuple(str(s) for s in rows)


async def _actor(session, current_user, tenant_id, reg) -> runtime.Actor:
    role = await _actor_role(session, current_user, tenant_id, reg)
    scope = view_role(current_user, role)
    sites = await _delegated_sites(session, tenant_id, reg["module_key"], current_user["sub"]) \
        if "executive" in (role, scope) else ()
    owned = await _owned_sites(session, tenant_id, reg["module_key"], current_user["sub"]) \
        if role != "observer" else ()
    return runtime.Actor(id=str(current_user["sub"]), role=role, delegated_sites=sites, owned_sites=owned)


def has_creator_rule(mdef: Optional[dict]) -> bool:
    """G3: does this module (in one release) have a creator-scoped stage?"""
    return any((s or {}).get("restricted_to") == runtime.CREATOR_RULE for s in (mdef or {}).get("stages") or [])


# ── gate facts ────────────────────────────────────────────────────────────────

async def build_facts(session: AsyncSession, tenant_id, site_id) -> dict:
    """The facts object gates evaluate for one site (F3 shape)."""
    facts: dict[str, Any] = {"reached": {}, "stages": {}, "fields": {}}
    aliases = {r["key"]: r["config_key"] for r in (await session.execute(text(
        "SELECT key, config_key FROM module_catalog WHERE config_key IS NOT NULL AND config_key <> key"
    ))).mappings().all()}
    rows = (await session.execute(text("""
        SELECT module_key, reached FROM site_module_outcomes WHERE tenant_id = :tid AND site_id = :sid
    """), {"tid": tenant_id, "sid": site_id})).mappings().all()
    for r in rows:
        reached = list(r["reached"] or [])
        facts["reached"][r["module_key"]] = reached
        if r["module_key"] in aliases:
            facts["reached"][aliases[r["module_key"]]] = reached
    cases = (await session.execute(text("""
        SELECT module_key, runtime_state FROM module_records WHERE tenant_id = :tid AND site_id = :sid
    """), {"tid": tenant_id, "sid": site_id})).mappings().all()
    for c in cases:
        st = c["runtime_state"] or {}
        facts["stages"][c["module_key"]] = list(st.get("completed") or [])
        merged: dict[str, Any] = {}
        for vals in (st.get("values") or {}).values():
            merged.update(vals)
        facts["fields"][c["module_key"]] = merged
    return facts


def _gate_out(rt: runtime.ModuleRuntime, facts: dict) -> dict:
    g = rt.gate_status(facts)
    gate = rt.m.get("entry_gate") or None
    return {"open": g["open"], "refusal": g["refusal"],
            "match": (gate or {}).get("match"),
            "conditions": [
                {**c, "met": c not in g["unmet"],
                 "reached": facts["reached"].get(c.get("source", c.get("src")), [])}
                for c in ((gate or {}).get("conditions") or [])
            ]}


# ── persistence helpers ───────────────────────────────────────────────────────

def _stage_status(state: dict, stage: dict) -> str:
    order = stage["order"]
    if order in state["completed"]:
        return stage["outcome"]
    if order == state["stage"]:
        if state["status"] == "rejected":
            return "rejected"
        if state["status"] in ("open", "in_progress"):
            return "submitted" if state["step"] > 0 else "in progress"
        if state["status"] == "parked":
            return "submitted"
    return "pending"


def _policy(ev: dict) -> str:
    if ev["type"] == "gate_opened":
        return "gate"
    if runtime.approval_row(ev) is not None:
        return "tier"
    return "runtime"


async def _write_events(session, *, tenant_id, site_id, record_id, release: dict, module_key: str,
                        events: list[dict], current_user: dict, facts: Optional[dict] = None) -> None:
    for ev in events:
        prov: dict[str, Any] = {"policy": _policy(ev), "release_version": release["version"],
                                "manifest_sha256": release["manifest_sha256"], "event": ev}
        if ev["type"] == "gate_opened" and facts is not None:
            prov["inputs"] = {"reached": facts["reached"]}
        if ev.get("override"):
            prov["override"] = True
        pl = ev.get("payload") or {}
        if pl.get("restricted_to"):  # G3: the creator step of a creator-scoped stage
            prov["rule"] = pl["restricted_to"]
            prov["site_creator"] = bool(pl.get("site_creator"))
            if ev.get("override") and not pl.get("site_creator"):
                prov["creator_override"] = True
        await write_provenance_audit(
            session, tenant_id=tenant_id, site_id=site_id,
            actor_id=current_user["sub"], actor_name=current_user.get("name"),
            action=f"module_{ev['type']}", entity_id=record_id, entity_type="module_record",
            detail=f"{module_key} v{release['version']} seq {ev['seq']}",
            config_release_id=release["id"], module_key=module_key, provenance=prov,
        )


async def _write_approvals(session, *, tenant_id, record_id, release: dict, events: list[dict]) -> None:
    for ev in events:
        row = runtime.approval_row(ev)
        if row is None:
            continue
        if ev["type"] == "submitted":
            # F2 ruling: record the form submission as 'submitted' (incl. an admin-only stage);
            # runtime.approval_row's rewrite to 'approved' was a workaround for the old guard.
            row["verdict"] = "submitted"
            if row.get("comment") == "sign-off with form":
                row["comment"] = None
        await session.execute(text("""
            INSERT INTO module_approvals
                (tenant_id, record_id, stage_order, release_id, tier, actor_id, actor_role,
                 acting_as_delegate, is_override, verdict, comment)
            VALUES (:tid, :rid, :stage, :rel, :tier, :actor, :arole, :deleg, :ovr, :verdict, :comment)
        """), {"tid": tenant_id, "rid": record_id, "stage": row["stage_order"], "rel": release["id"],
               "tier": row["tier"], "actor": row["actor_id"], "arole": row["actor_role"],
               "deleg": row["acting_as_delegate"], "ovr": bool(ev.get("override")),
               "verdict": row["verdict"], "comment": row["comment"]})


async def _write_stages(session, *, tenant_id, record_id, rt: runtime.ModuleRuntime, state: dict,
                        events: list[dict], actor_id) -> None:
    submitted = {ev["payload"]["stage"] for ev in events if ev["type"] == "submitted"}
    decided = {ev["payload"]["stage"] for ev in events
               if ev["type"] in ("stage_completed", "rejected", "rejected_forward")}
    import json
    for st in rt.stages:
        order = st["order"]
        await session.execute(text("""
            INSERT INTO module_stage_states
                (record_id, stage_order, tenant_id, stage_name, status, field_values,
                 submitted_by, submitted_at, decided_at)
            VALUES (:rid, :o, :tid, :name, :status, CAST(:vals AS jsonb),
                    :sby, CASE WHEN :is_sub THEN now() END, CASE WHEN :is_dec THEN now() END)
            ON CONFLICT (record_id, stage_order) DO UPDATE
               SET status = EXCLUDED.status,
                   field_values = EXCLUDED.field_values,
                   submitted_by = CASE WHEN :is_sub THEN EXCLUDED.submitted_by
                                       ELSE module_stage_states.submitted_by END,
                   submitted_at = CASE WHEN :is_sub THEN now() ELSE module_stage_states.submitted_at END,
                   decided_at   = CASE WHEN :is_dec THEN now() ELSE module_stage_states.decided_at END
        """), {"rid": record_id, "o": order, "tid": tenant_id, "name": st["name"],
               "status": _stage_status(state, st),
               "vals": json.dumps(state["values"].get(str(order), {})),
               "sby": actor_id if order in submitted else None,
               "is_sub": order in submitted, "is_dec": order in decided})


# ── commands ──────────────────────────────────────────────────────────────────

async def svc_open_record(session: AsyncSession, *, tenant_id, current_user: dict,
                          module_key: str, site_id: str) -> dict:
    """Open the module's case for a site — refused (409 gate_closed) while the entry gate is closed."""
    import json

    async with transaction(session):
        reg = await _custom_module(session, tenant_id, module_key)
        role = await _actor_role(session, current_user, tenant_id, reg)
        if role == "observer":
            raise HTTPException(status_code=403, detail="Observer access is read-only.")
        site = (await session.execute(text("""
            SELECT id, config_release_id FROM sites
             WHERE id = CAST(:sid AS uuid) AND tenant_id = :tid FOR UPDATE
        """), {"sid": site_id, "tid": tenant_id})).mappings().first()
        if not site:
            raise HTTPException(status_code=404, detail="Site not found.")
        existing = (await session.execute(text(
            "SELECT id FROM module_records WHERE site_id = :sid AND module_key = :m"
        ), {"sid": site["id"], "m": module_key})).scalar_one_or_none()
        if existing:
            raise ApiProblem(409, f"{reg['label']} is already open for this site.",
                             code="record_exists", record_id=str(existing))
        release_id = site["config_release_id"] or (await session.execute(text(
            "SELECT release_id FROM tenant_config_live WHERE tenant_id = :tid"
        ), {"tid": tenant_id})).scalar_one_or_none()
        if not release_id:
            raise ApiProblem(409, "This workspace has no published configuration.", code="no_release")
        release = await load_release(session, tenant_id, release_id)
        mdef = module_def(release, module_key)
        if not mdef:
            raise ApiProblem(409, f"{reg['label']} is not part of configuration v{release['version']}, "
                                  f"which this site runs on.", code="module_not_in_release",
                             release_version=release["version"])
        if not mdef.get("enabled", True):
            raise ApiProblem(409, f"{reg['label']} is switched off in configuration v{release['version']}, "
                                  f"which this site runs on.", code="module_disabled_in_release",
                             release_version=release["version"])
        rt = runtime_for(release, mdef)
        facts = await build_facts(session, tenant_id, site["id"])
        gate = _gate_out(rt, facts)
        if not gate["open"]:
            raise ApiProblem(409, gate["refusal"] or f"{reg['label']} is locked.", code="gate_closed", gate=gate)
        if site["config_release_id"] is None:
            # A site created before the tenant's first publish is legacy (NULL pin). The first
            # custom-module case adopts it into the live release, so every later case on the
            # site runs the same version (trg_sites_pin_release allows NULL -> release).
            await session.execute(text(
                "UPDATE sites SET config_release_id = :rel WHERE id = :sid AND config_release_id IS NULL"
            ), {"rel": release["id"], "sid": site["id"]})
            await write_provenance_audit(
                session, tenant_id=tenant_id, site_id=site["id"], actor_id=current_user["sub"],
                actor_name=current_user.get("name"), action="site_adopted_into_release",
                entity_id=site["id"], entity_type="site", detail=f"v{release['version']}",
                config_release_id=release["id"], module_key=module_key,
                provenance={"policy": "repin", "from": None, "to": release["id"],
                            "release_version": release["version"], "reason": "first custom-module case"},
            )

        record_id = uuid.uuid4()
        state, events = rt.new_case(str(record_id), str(site["id"]), facts)
        row = runtime.module_record_row(state, mdef.get("exit_signal"))
        await session.execute(text("""
            INSERT INTO module_records
                (id, tenant_id, site_id, module_key, release_id, status, current_stage, exit_outcome,
                 opened_by, runtime_state, closed_at)
            VALUES (:id, :tid, :sid, :m, :rel, :status, :stage, :exit, :uid, CAST(:state AS jsonb),
                    CASE WHEN CAST(:exit AS text) IS NULL THEN NULL ELSE now() END)
        """), {"id": record_id, "tid": tenant_id, "sid": site["id"], "m": module_key, "rel": release["id"],
               "status": row["status"], "stage": row["current_stage"], "exit": row["exit_outcome"],
               "uid": current_user["sub"], "state": json.dumps(state)})
        await _write_stages(session, tenant_id=tenant_id, record_id=record_id, rt=rt, state=state,
                            events=events, actor_id=current_user["sub"])
        await _write_events(session, tenant_id=tenant_id, site_id=site["id"], record_id=record_id,
                            release=release, module_key=module_key, events=events,
                            current_user=current_user, facts=facts)
    return await svc_get_record(session, tenant_id=tenant_id, current_user=current_user,
                                module_key=module_key, record_id=str(record_id))


async def svc_act(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str, record_id: str,
                  action: str, values: Optional[dict], reason: Optional[str], to_stage: Optional[int],
                  expected_seq: Optional[int]) -> dict:
    """submit | approve | reject | send_back on the case's current step (one locked transaction)."""
    import json

    async with transaction(session):
        reg = await _custom_module(session, tenant_id, module_key)
        actor = await _actor(session, current_user, tenant_id, reg)
        rec = (await session.execute(text("""
            SELECT id, site_id, release_id, runtime_state FROM module_records
             WHERE id = CAST(:rid AS uuid) AND tenant_id = :tid AND module_key = :m
             FOR UPDATE
        """), {"rid": record_id, "tid": tenant_id, "m": module_key})).mappings().first()
        if not rec:
            raise HTTPException(status_code=404, detail="Record not found.")
        state = rec["runtime_state"]
        if expected_seq is not None and state.get("seq") != expected_seq:
            raise ApiProblem(409, "This case changed since you loaded it; reload and try again.",
                             code="stale", seq=state.get("seq"))
        release = await load_release(session, tenant_id, rec["release_id"])
        mdef = module_def(release, module_key)
        if not mdef:  # cannot happen: the DB guard checked it on insert, releases are immutable
            raise ApiProblem(409, "Module missing from the pinned release.", code="release_mismatch")
        rt = runtime_for(release, mdef)
        if action == "submit" and values:
            await _check_file_values(session, tenant_id=tenant_id, record_id=rec["id"], rt=rt, state=state,
                                     values=values)
        facts = await build_facts(session, tenant_id, rec["site_id"])
        payload: dict[str, Any] = {"values": values or {}}
        if reason is not None:
            payload["reason"] = reason
        if to_stage is not None:
            payload["to_stage"] = to_stage
        try:
            new_state, events = rt.act(state, actor, action, payload, facts)
        except runtime.Refusal as r:
            extra: dict[str, Any] = {}
            if r.code == "invalid_form":
                nxt = rt.next_step(state) or {}
                schema = (nxt.get("form") or {}).get("schema")
                extra["errors"] = forms.validate_submission(schema, values or {}) if schema else [r.message]
            if r.code == "gate_closed":
                extra["gate"] = _gate_out(rt, facts)
            raise ApiProblem(_REFUSAL_STATUS.get(r.code, 409), r.message, code=r.code, **extra)

        row = runtime.module_record_row(new_state, mdef.get("exit_signal"))
        await session.execute(text("""
            UPDATE module_records
               SET status = :status, current_stage = :stage, exit_outcome = :exit,
                   closed_at = CASE WHEN CAST(:exit AS text) IS NULL THEN NULL ELSE coalesce(closed_at, now()) END,
                   runtime_state = CAST(:state AS jsonb)
             WHERE id = :rid
        """), {"status": row["status"], "stage": row["current_stage"], "exit": row["exit_outcome"],
               "state": json.dumps(new_state), "rid": rec["id"]})
        await _write_stages(session, tenant_id=tenant_id, record_id=rec["id"], rt=rt, state=new_state,
                            events=events, actor_id=current_user["sub"])
        await _write_approvals(session, tenant_id=tenant_id, record_id=rec["id"], release=release, events=events)
        await _write_events(session, tenant_id=tenant_id, site_id=rec["site_id"], record_id=rec["id"],
                            release=release, module_key=module_key, events=events, current_user=current_user)
    return await svc_get_record(session, tenant_id=tenant_id, current_user=current_user,
                                module_key=module_key, record_id=record_id)


async def svc_assign(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                     record_id: str, executive_id: str) -> dict:
    """Supervisor / business admin assigns the case to an executive of the module. Writes the
    site_delegations row (module = this key) the runtime's delegation tier reads, and
    module_records.assigned_to."""
    async with transaction(session):
        reg = await _custom_module(session, tenant_id, module_key)
        role = await _actor_role(session, current_user, tenant_id, reg)
        if role not in ("supervisor", "business_admin"):
            raise HTTPException(status_code=403, detail="Only a supervisor or business admin can assign a case.")
        rec = (await session.execute(text("""
            SELECT id, site_id, release_id FROM module_records
             WHERE id = CAST(:rid AS uuid) AND tenant_id = :tid AND module_key = :m FOR UPDATE
        """), {"rid": record_id, "tid": tenant_id, "m": module_key})).mappings().first()
        if not rec:
            raise HTTPException(status_code=404, detail="Record not found.")
        member = (await session.execute(text("""
            SELECT 1 FROM user_module_memberships umm JOIN users u ON u.id = umm.user_id
             WHERE umm.tenant_id = :tid AND umm.module = :m AND umm.user_id = CAST(:uid AS uuid)
               AND umm.role_in_module = 'executive' AND u.is_active
             LIMIT 1
        """), {"tid": tenant_id, "m": module_key, "uid": executive_id})).first()
        if not member:
            raise HTTPException(status_code=404,
                                detail=f"No active executive of {reg['label']} with that id.")
        await session.execute(text("""
            INSERT INTO site_delegations (tenant_id, site_id, module, delegate_user_id, granted_by, notes)
            VALUES (:tid, :sid, :m, CAST(:uid AS uuid), :by, :notes)
            ON CONFLICT (site_id, module, delegate_user_id) WHERE revoked_at IS NULL DO NOTHING
        """), {"tid": tenant_id, "sid": rec["site_id"], "m": module_key, "uid": executive_id,
               "by": current_user["sub"], "notes": f"assigned via {module_key} case {record_id}"})
        await session.execute(text("""
            UPDATE module_records
               SET assigned_to = CAST(:uid AS uuid),
                   supervisor_id = CASE WHEN :is_sup THEN coalesce(supervisor_id, CAST(:me AS uuid))
                                        ELSE supervisor_id END
             WHERE id = :rid
        """), {"uid": executive_id, "is_sup": role == "supervisor", "me": current_user["sub"], "rid": rec["id"]})
        release = await load_release(session, tenant_id, rec["release_id"])
        await write_provenance_audit(
            session, tenant_id=tenant_id, site_id=rec["site_id"], actor_id=current_user["sub"],
            actor_name=current_user.get("name"), action="module_record_assigned",
            entity_id=rec["id"], entity_type="module_record", detail=f"{module_key} -> {executive_id}",
            config_release_id=release["id"], module_key=module_key,
            provenance={"policy": "delegation", "release_version": release["version"],
                        "delegate_user_id": executive_id, "actor_role": role},
        )
    return await svc_get_record(session, tenant_id=tenant_id, current_user=current_user,
                                module_key=module_key, record_id=record_id)


# ── reads ─────────────────────────────────────────────────────────────────────

def _iso(v):
    return v.isoformat() if v is not None else None


async def _live_version(session, tenant_id) -> Optional[int]:
    return (await session.execute(text("""
        SELECT r.version FROM tenant_config_live l JOIN tenant_config_releases r ON r.id = l.release_id
         WHERE l.tenant_id = :tid
    """), {"tid": tenant_id})).scalar_one_or_none()


async def svc_list_records(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                           site_id: Optional[str] = None, view_id: Optional[str] = None) -> dict:
    """Cases of a custom module visible to the caller (+ ``site_gate`` for one site).

    Scope first (tenant; executives: opened / assigned / delegated, plus — G3 — sites they own when
    the case's module has a creator-scoped stage), then the saved view's filter (``view_id``) on
    top: a view can only narrow what the scope allows."""
    reg = await _custom_module(session, tenant_id, module_key)
    actor = await _actor(session, current_user, tenant_id, reg)
    scope = view_role(current_user, actor.role)  # F5a/E3: scope + views follow the effective role
    view = await views_svc.get_view_for(session, tenant_id, module_key, view_id, scope) if view_id else None
    params: dict[str, Any] = {"tid": tenant_id, "m": module_key}
    where = "r.tenant_id = :tid AND r.module_key = :m"
    if site_id:
        where += " AND r.site_id = CAST(:sid AS uuid)"
        params["sid"] = site_id
    if scope == "executive":
        # an executive sees the cases of sites delegated/assigned to them, and the ones they opened;
        # G3: also sites they own — kept below only where the module has a creator-scoped stage
        where += (" AND (r.opened_by = :uid OR r.assigned_to = :uid OR r.site_id::text = ANY(:sites)"
                  " OR r.site_id::text = ANY(:owned))")
        params["uid"] = actor.id
        params["sites"] = list(actor.delegated_sites)
        params["owned"] = list(actor.owned_sites)
    rows = (await session.execute(text(f"""
        SELECT r.id, r.site_id, r.status, r.current_stage, r.exit_outcome, r.opened_at, r.closed_at,
               r.assigned_to, r.release_id, r.runtime_state, r.opened_by,
               s.name AS site_name, s.code AS site_code, s.ca_code, s.city,
               s.submitted_by AS site_submitted_by, s.assigned_to AS site_assigned_to
          FROM module_records r JOIN sites s ON s.id = r.site_id
         WHERE {where}
         ORDER BY r.opened_at DESC
    """), params)).mappings().all()  # noqa: S608 — `where` is built from fixed literals only
    items = []
    for r in rows:
        release = await load_release(session, tenant_id, r["release_id"])
        mdef = module_def(release, module_key)
        if scope == "executive" and not _executive_sees(actor, r, mdef):
            continue
        items.append(_list_item(r, release, mdef, actor))
    if view:
        items = [i for i in items if views_svc.matches(i, view["filter"], me=actor.id, role=scope,
                                                       delegated=actor.delegated_sites)]
    for i in items:
        for k in [k for k in i if k.startswith("_")]:
            del i[k]
    out: dict[str, Any] = {"module": {"key": reg["module_key"], "label": reg["label"]},
                           "role": actor.role, "view_role": scope, "items": items, "total": len(items)}
    if view:
        out["view"] = {k: view[k] for k in ("id", "name", "filter", "columns", "seed_key")}
    if site_id:
        out["site_gate"] = await _site_gate(session, tenant_id, reg, site_id, has_record=bool(items))
    return out


def _executive_sees(actor: runtime.Actor, r, mdef: Optional[dict]) -> bool:
    """Executive scope of one case: opened / assigned / delegated, or owns the site of a module
    with a creator-scoped stage (G3: the creator must see the case it alone may act on)."""
    if str(r["opened_by"]) == actor.id or str(r["assigned_to"] or "") == actor.id \
            or str(r["site_id"]) in actor.delegated_sites:
        return True
    return str(r["site_id"]) in actor.owned_sites and has_creator_rule(mdef)


def _list_item(r, release: dict, mdef: Optional[dict], actor: runtime.Actor) -> dict:
    rt = runtime_for(release, mdef) if mdef else None
    st = r["runtime_state"]
    nxt = rt.next_step(st) if rt else None
    return {
        "id": str(r["id"]),
        "site": {"id": str(r["site_id"]), "name": r["site_name"], "code": r["ca_code"] or r["site_code"],
                 "city": r["city"]},
        "status": r["status"], "case_status": st.get("status"), "current_stage": r["current_stage"],
        "exit_outcome": r["exit_outcome"], "release_version": release["version"],
        "next_step": None if not nxt else {"stage": nxt["stage"], "name": nxt["name"],
                                           "role": nxt["role"], "kind": nxt["kind"],
                                           "restricted_to": nxt.get("restricted_to")},
        "allowed_actions": rt.actions(st, actor) if rt else [],
        "assigned_to": str(r["assigned_to"]) if r["assigned_to"] else None,
        "opened_by": str(r["opened_by"]) if r["opened_by"] else None,
        "owned_by_me": str(r["site_id"]) in actor.owned_sites,
        "opened_at": _iso(r["opened_at"]), "closed_at": _iso(r["closed_at"]),
        # internal (stripped before the response): the view filter's inputs
        "_opened_by": str(r["opened_by"]) if r["opened_by"] else None,
        "_site_submitted_by": str(r["site_submitted_by"]) if r["site_submitted_by"] else None,
        "_site_assigned_to": str(r["site_assigned_to"]) if r["site_assigned_to"] else None,
    }


async def _site_gate(session, tenant_id, reg, site_id: str, *, has_record: bool) -> dict:
    """Could this module be opened on the site now? (release the site runs on + gate status)."""
    site = (await session.execute(text("""
        SELECT id, config_release_id FROM sites WHERE id = CAST(:sid AS uuid) AND tenant_id = :tid
    """), {"sid": site_id, "tid": tenant_id})).mappings().first()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found.")
    rid = site["config_release_id"] or (await session.execute(text(
        "SELECT release_id FROM tenant_config_live WHERE tenant_id = :tid"), {"tid": tenant_id})).scalar_one_or_none()
    if not rid:
        return {"can_open": False, "reason": "no_release", "release_version": None, "gate": None}
    release = await load_release(session, tenant_id, rid)
    mdef = module_def(release, reg["module_key"])
    if not mdef or not mdef.get("enabled", True):
        return {"can_open": False, "reason": "module_not_in_release", "release_version": release["version"],
                "gate": None}
    gate = _gate_out(runtime_for(release, mdef), await build_facts(session, tenant_id, site["id"]))
    return {"can_open": gate["open"] and not has_record,
            "reason": "record_exists" if has_record else (None if gate["open"] else "gate_closed"),
            "release_version": release["version"], "pinned": site["config_release_id"] is not None,
            "gate": gate}


async def svc_get_record(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                         record_id: str) -> dict:
    """One case: pinned release, stages, current form, allowed actions, gate, approvals, audit."""
    reg = await _custom_module(session, tenant_id, module_key)
    actor = await _actor(session, current_user, tenant_id, reg)
    rec = (await session.execute(text("""
        SELECT r.*, s.name AS site_name, s.code AS site_code, s.ca_code, s.city,
               s.config_release_id AS site_release_id
          FROM module_records r JOIN sites s ON s.id = r.site_id
         WHERE r.id = CAST(:rid AS uuid) AND r.tenant_id = :tid AND r.module_key = :m
    """), {"rid": record_id, "tid": tenant_id, "m": module_key})).mappings().first()
    if not rec:
        raise HTTPException(status_code=404, detail="Record not found.")
    release = await load_release(session, tenant_id, rec["release_id"])
    mdef = module_def(release, module_key)
    scope = view_role(current_user, actor.role)  # F5a/E3: scope follows the effective role
    if scope == "executive" and not _executive_sees(actor, rec, mdef):
        raise HTTPException(status_code=404, detail="Record not found.")
    rt = runtime_for(release, mdef)
    st = rec["runtime_state"]
    facts = await build_facts(session, tenant_id, rec["site_id"])
    nxt = rt.next_step(st)
    stage_rows = {r["stage_order"]: r for r in (await session.execute(text("""
        SELECT stage_order, status, field_values, submitted_by, submitted_at, decided_at
          FROM module_stage_states WHERE record_id = :rid
    """), {"rid": rec["id"]})).mappings().all()}
    approvals = (await session.execute(text("""
        SELECT a.stage_order, a.tier, a.actor_id, u.name AS actor_name, a.actor_role, a.acting_as_delegate,
               a.is_override, a.verdict, a.comment, a.decided_at, a.release_id
          FROM module_approvals a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.record_id = :rid ORDER BY a.decided_at, a.id
    """), {"rid": rec["id"]})).mappings().all()
    audit = (await session.execute(text("""
        SELECT action, actor_id, actor_name, detail, config_release_id, module_key, provenance, created_at
          FROM audit_logs
         WHERE tenant_id = :tid AND entity_id = :rid AND entity_type = 'module_record'
         ORDER BY created_at, (provenance -> 'event' ->> 'seq')::int NULLS LAST
    """), {"tid": tenant_id, "rid": rec["id"]})).mappings().all()
    chain_events = [a["provenance"]["event"] for a in audit if (a["provenance"] or {}).get("event")]
    chain_events.sort(key=lambda e: e["seq"])
    files = await _record_files(session, tenant_id, rec["id"])
    return {
        "record": {
            "id": str(rec["id"]), "module_key": module_key, "status": rec["status"],
            "case_status": st.get("status"), "verdict": st.get("verdict"), "current_stage": rec["current_stage"],
            "exit_outcome": rec["exit_outcome"], "reached": st.get("reached", []), "seq": st.get("seq"),
            "site": {"id": str(rec["site_id"]), "name": rec["site_name"], "code": rec["ca_code"] or rec["site_code"],
                     "city": rec["city"]},
            "opened_by": str(rec["opened_by"]) if rec["opened_by"] else None,
            "assigned_to": str(rec["assigned_to"]) if rec["assigned_to"] else None,
            "supervisor_id": str(rec["supervisor_id"]) if rec["supervisor_id"] else None,
            "opened_at": _iso(rec["opened_at"]), "closed_at": _iso(rec["closed_at"]),
        },
        "release": {"id": release["id"], "version": release["version"], "pinned": True,
                    "site_pinned_release_id": str(rec["site_release_id"]) if rec["site_release_id"] else None,
                    "live_version": await _live_version(session, tenant_id)},
        "module": {"key": module_key, "label": reg["label"], "name": mdef.get("name"),
                   "tiers": mdef.get("tiers"), "exit_signal": mdef.get("exit_signal")},
        "stages": [{
            "order": s["order"], "name": s["name"], "outcome": s["outcome"], "terminal": bool(s.get("terminal")),
            "chain": rt.chain(s), "restricted_to": s.get("restricted_to"),
            "state": (stage_rows.get(s["order"]) or {}).get("status") or _stage_status(st, s),
            "field_values": (stage_rows.get(s["order"]) or {}).get("field_values") or {},
            "submitted_by": str(stage_rows[s["order"]]["submitted_by"])
            if s["order"] in stage_rows and stage_rows[s["order"]]["submitted_by"] else None,
            "submitted_at": _iso((stage_rows.get(s["order"]) or {}).get("submitted_at")),
            "decided_at": _iso((stage_rows.get(s["order"]) or {}).get("decided_at")),
            "fields": s.get("fields") or [],
        } for s in rt.stages],
        "next_step": None if not nxt else {
            "stage": nxt["stage"], "name": nxt["name"], "role": nxt["role"], "kind": nxt["kind"],
            "restricted_to": nxt.get("restricted_to"),
            "form": None if not nxt["form"] else {"schema": nxt["form"]["schema"],
                                                  "uiSchema": nxt["form"]["uiSchema"],
                                                  "unparsed": nxt["form"]["unparsed"]},
        },
        "me": {"id": actor.id, "role": actor.role, "view_role": scope,
               "owns_site": str(rec["site_id"]) in actor.owned_sites},
        "allowed_actions": rt.actions(st, actor),
        "gate": _gate_out(rt, facts),
        "approvals": [{**{k: (str(v) if isinstance(v, UUID) else v) for k, v in a.items()},
                       "decided_at": _iso(a["decided_at"])} for a in approvals],
        "audit": [{"action": a["action"], "actor_id": str(a["actor_id"]) if a["actor_id"] else None,
                   "actor_name": a["actor_name"], "detail": a["detail"],
                   "config_release_id": str(a["config_release_id"]) if a["config_release_id"] else None,
                   "module_key": a["module_key"], "provenance": a["provenance"], "at": _iso(a["created_at"])}
                  for a in audit],
        "audit_chain_valid": runtime.verify_chain(chain_events) if chain_events else None,
        "files": files,  # F5a: {file_id: {file_name, content_type, size, stage, field, uploaded_at}}
    }


async def svc_list_members(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str) -> dict:
    """Active members of a custom module (for the assign picker / MatrixPersonWidget)."""
    reg = await _custom_module(session, tenant_id, module_key)
    await _actor_role(session, current_user, tenant_id, reg)  # members, admins and observers only
    rows = (await session.execute(text("""
        SELECT DISTINCT u.id, u.name, u.email, umm.role_in_module
          FROM user_module_memberships umm JOIN users u ON u.id = umm.user_id
         WHERE umm.tenant_id = :tid AND umm.module = :m AND u.is_active
         ORDER BY umm.role_in_module DESC, u.name
    """), {"tid": tenant_id, "m": module_key})).mappings().all()
    return {"module": {"key": reg["module_key"], "label": reg["label"]},
            "items": [{"id": str(r["id"]), "name": r["name"], "email": r["email"],
                       "role_in_module": r["role_in_module"]} for r in rows]}


# ── F5a: files for `kind: file` fields ──────────────────────────────────────────

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$", re.IGNORECASE)
_SIZE_UNIT = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}
# Field hint extensions (forms.py normalises jpg -> jpeg) -> the MIME types that may carry them.
_EXT_MIME = {
    "pdf": {"application/pdf"}, "jpeg": {"image/jpeg", "image/jpg"}, "png": {"image/png"},
    "webp": {"image/webp"}, "gif": {"image/gif"}, "heic": {"image/heic", "image/heif"},
    "heif": {"image/heic", "image/heif"}, "doc": {"application/msword"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "xls": {"application/vnd.ms-excel"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, "csv": {"text/csv"},
}


def _file_field(rt: runtime.ModuleRuntime, state: dict, field_key: str) -> tuple[dict, dict]:
    """(next step, the field's ui:options) — the field must be a `file` field of the CURRENT form step."""
    nxt = rt.next_step(state)
    if not nxt or nxt["kind"] != "submit" or not nxt.get("form"):
        raise ApiProblem(409, "This case is not waiting for a form submission.", code="wrong_action")
    stage = next((s for s in rt.stages if s["order"] == nxt["stage"]), {})
    field = next((f for f in stage.get("fields") or [] if f.get("key") == field_key), None)
    if not field or field.get("kind") != "file":
        raise ApiProblem(422, f"Stage {nxt['stage']} has no file field '{field_key}'.", code="unknown_field")
    opts = ((nxt["form"].get("uiSchema") or {}).get(field_key) or {}).get("ui:options") or {}
    return nxt, opts


def file_limit_bytes(opts: dict) -> int:
    """The field's own size limit (its validation hint, e.g. "PDF, max 5MB"), never above MAX_UPLOAD_BYTES."""
    cap = settings.max_upload_bytes
    m = _SIZE_RE.match(str(opts.get("maxSize") or "").strip())
    if m:
        cap = min(cap, int(float(m.group(1)) * _SIZE_UNIT[m.group(2).upper()]))
    return cap


def check_file_type(opts: dict, file_name: str, content_type: str) -> None:
    """The field's accepted types (hint, e.g. ".pdf,.jpeg"): both extension and declared type must match.
    (The app-wide MIME allowlist + magic-byte check already ran in read_upload_capped.)"""
    accept = [a.strip().lstrip(".").lower() for a in str(opts.get("accept") or "").split(",") if a.strip()]
    if not accept:
        return
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    ext = "jpeg" if ext == "jpg" else ext
    mimes = set().union(*(_EXT_MIME.get(a, set()) for a in accept))
    if ext not in accept or (mimes and content_type not in mimes):
        raise ApiProblem(415, f"This field accepts {', '.join('.' + a for a in accept)} files only.",
                         code="file_type")


async def svc_upload_file(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                          record_id: str, field_key: str, upload: UploadFile) -> dict:
    """Store a file for a `kind: file` field of the case's current form step (F5a).

    Only someone the runtime lets SUBMIT that step may upload (same tier/creator/delegation rules,
    business-admin override included). Validated before any byte is stored: the field's own size
    and type hint, the app's MIME allowlist and magic bytes (read_upload_capped). The bytes go to
    the app's storage bucket under module-files/<tenant>/<module>/<record>/<file id>/ — the read
    transaction is released first (no DB connection held across storage I/O) — then ONE
    transaction inserts the module_files row + a ``module_file_uploaded`` audit row on the case.
    If that insert fails the stored object is deleted again. Returns the file id the form submits.
    """
    reg = await _custom_module(session, tenant_id, module_key)
    actor = await _actor(session, current_user, tenant_id, reg)
    rec = (await session.execute(text("""
        SELECT id, site_id, release_id, runtime_state FROM module_records
         WHERE id = CAST(:rid AS uuid) AND tenant_id = :tid AND module_key = :m
    """), {"rid": record_id, "tid": tenant_id, "m": module_key})).mappings().first()
    if not rec:
        raise HTTPException(status_code=404, detail="Record not found.")
    release = await load_release(session, tenant_id, rec["release_id"])
    rt = runtime_for(release, module_def(release, module_key))
    nxt, opts = _file_field(rt, rec["runtime_state"], field_key)
    if "submit" not in rt.actions(rec["runtime_state"], actor):
        raise ApiProblem(403, "Only whoever may submit this step can upload its files.", code="wrong_tier")
    await session.rollback()  # release the read transaction before the (slow) storage I/O (#235)

    body = await read_upload_capped(upload, max_bytes=file_limit_bytes(opts))
    if not body:
        raise ApiProblem(422, "The file is empty.", code="empty_file")
    name = (upload.filename or "file").strip()[:255] or "file"
    ctype = upload.content_type or "application/octet-stream"
    check_file_type(opts, name, ctype)
    file_id = uuid.uuid4()
    path = (f"module-files/{tenant_id}/{module_key}/{rec['id']}/{file_id}/"
            f"{storage_service.safe_object_name(name)}")
    sha = hashlib.sha256(body).hexdigest()
    await storage_service.upload_bytes(path=path, body=body, content_type=ctype)
    try:
        async with transaction(session):
            await session.execute(text("""
                INSERT INTO module_files (id, tenant_id, site_id, record_id, module_key, stage_order, field_key,
                                          storage_path, file_name, content_type, size_bytes, sha256, uploaded_by)
                VALUES (:id, :tid, :sid, :rid, :m, :stage, :field, :path, :name, :ctype, :size, :sha, :uid)
            """), {"id": file_id, "tid": tenant_id, "sid": rec["site_id"], "rid": rec["id"], "m": module_key,
                   "stage": nxt["stage"], "field": field_key, "path": path, "name": name, "ctype": ctype,
                   "size": len(body), "sha": sha, "uid": current_user["sub"]})
            await write_provenance_audit(
                session, tenant_id=tenant_id, site_id=rec["site_id"], actor_id=current_user["sub"],
                actor_name=current_user.get("name"), action="module_file_uploaded", entity_id=rec["id"],
                entity_type="module_record", detail=f"stage {nxt['stage']} · {field_key}: {name}",
                config_release_id=rec["release_id"], module_key=module_key,
                provenance={"policy": "files", "release_version": release["version"], "stage": nxt["stage"],
                            "field": field_key, "file_id": str(file_id), "file_name": name, "sha256": sha,
                            "size": len(body), "content_type": ctype, "actor_role": actor.role},
            )
    except Exception:
        await storage_service.delete_object(path=path)  # never leave an unreferenced object behind
        raise
    return {"id": str(file_id), "file_name": name, "content_type": ctype, "size": len(body), "sha256": sha,
            "stage": nxt["stage"], "field": field_key}


async def svc_get_file(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                       file_id: str) -> dict:
    """A file of a case, with a short-lived signed download URL — visible exactly when its case is."""
    reg = await _custom_module(session, tenant_id, module_key)
    actor = await _actor(session, current_user, tenant_id, reg)
    row = (await session.execute(text("""
        SELECT f.id, f.file_name, f.content_type, f.size_bytes, f.sha256, f.storage_path, f.stage_order,
               f.field_key, f.created_at, r.id AS record_id, r.site_id, r.opened_by, r.assigned_to, r.release_id
          FROM module_files f JOIN module_records r ON r.id = f.record_id
         WHERE f.id = CAST(:fid AS uuid) AND f.tenant_id = :tid AND f.module_key = :m
    """), {"fid": file_id, "tid": tenant_id, "m": module_key})).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="File not found.")
    if view_role(current_user, actor.role) == "executive":
        release = await load_release(session, tenant_id, row["release_id"])
        if not _executive_sees(actor, row, module_def(release, module_key)):
            raise HTTPException(status_code=404, detail="File not found.")
    await session.rollback()
    url = await storage_service.signed_url(row["storage_path"], expires_in=300)
    if not url:
        raise HTTPException(status_code=503, detail="File storage is not reachable right now.")
    return {"id": str(row["id"]), "record_id": str(row["record_id"]), "file_name": row["file_name"],
            "content_type": row["content_type"], "size": row["size_bytes"], "sha256": row["sha256"],
            "stage": row["stage_order"], "field": row["field_key"], "uploaded_at": _iso(row["created_at"]),
            "url": url, "expires_in": 300}


async def _record_files(session: AsyncSession, tenant_id, record_id) -> dict[str, dict]:
    rows = (await session.execute(text("""
        SELECT id, file_name, content_type, size_bytes, stage_order, field_key, created_at
          FROM module_files WHERE tenant_id = :tid AND record_id = :rid ORDER BY created_at
    """), {"tid": tenant_id, "rid": record_id})).mappings().all()
    return {str(r["id"]): {"file_name": r["file_name"], "content_type": r["content_type"], "size": r["size_bytes"],
                           "stage": r["stage_order"], "field": r["field_key"], "uploaded_at": _iso(r["created_at"])}
            for r in rows}


async def _check_file_values(session: AsyncSession, *, tenant_id, record_id, rt: runtime.ModuleRuntime,
                             state: dict, values: dict) -> None:
    """A submitted file-field value must be the id of a file uploaded for THIS record, stage and field —
    never a typed reference, another case's file or another tenant's."""
    nxt = rt.next_step(state)
    if not nxt or nxt["kind"] != "submit":
        return
    stage = next((s for s in rt.stages if s["order"] == nxt["stage"]), {})
    keys = [f["key"] for f in stage.get("fields") or []
            if f.get("kind") == "file" and values.get(f["key"]) not in (None, "")]
    errors = []
    for k in keys:
        v = values[k]
        if not isinstance(v, str) or not _UUID_RE.match(v):
            errors.append(f"{k}: upload the file — a typed reference is not accepted")
            continue
        found = (await session.execute(text("""
            SELECT 1 FROM module_files
             WHERE id = CAST(:fid AS uuid) AND tenant_id = :tid AND record_id = :rid
               AND stage_order = :stage AND field_key = :field
        """), {"fid": v, "tid": tenant_id, "rid": record_id, "stage": nxt["stage"], "field": k})).first()
        if not found:
            errors.append(f"{k}: unknown file — upload it again")
    if errors:
        raise ApiProblem(422, "Some files of this step are not uploaded for this case.", code="invalid_form",
                         errors=errors)
