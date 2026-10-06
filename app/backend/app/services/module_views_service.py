"""Role-scoped saved views for custom-module pages (Phase 2b, G3 #4).

Idea from the user's operaton-plat (Tasklist filters "My tasks" / "Team queue" / "Admin approvals",
each made visible to a group by a READ grant — ``sync_views`` / ``op_add_view``). Here a view is a
row of ``module_views`` (migration 20261005_3): name, filter, columns, AUDIENCE roles, position,
is_default. Rules (docs/catalogue-crosscheck/for-G3.md §2.3):

* audience is not access — it decides who sees the view in the switcher. Data access is the
  runtime's scope (module_runtime_service.svc_list_records), applied FIRST; the view's filter is
  applied on top and can only narrow it;
* the caller's role is the role the runtime acts with (business_admin / observer workspace-wide,
  else the module membership tier);
* business admins manage views (create / edit / delete / reset to defaults); everyone else reads
  the views whose audience includes their role. Defaults are seeded by the DB
  (``cfg_seed_module_views``) when a custom module is enabled by a publish.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.problems import ApiProblem
from app.db.session import transaction
from app.domain.schemas.module_views import ViewFilter, ViewIn, ViewPatch
from app.services.audit_service import write_provenance_audit

_CLOSED = ("completed", "rejected", "parked")

_VIEW_COLS = """
    id, module_key, name, filter, columns, audience, position, is_default, seed_key, created_by,
    created_at, updated_at
"""


def _iso(v):
    return v.isoformat() if v is not None else None


def view_out(r) -> dict:
    """A module_views row as the API shape."""
    return {"id": str(r["id"]), "module_key": r["module_key"], "all_modules": r["module_key"] is None,
            "name": r["name"], "filter": r["filter"] or {}, "columns": r["columns"] or [],
            "audience": list(r["audience"] or []), "position": r["position"], "is_default": r["is_default"],
            "seed_key": r["seed_key"], "created_by": str(r["created_by"]) if r["created_by"] else None,
            "updated_at": _iso(r["updated_at"])}


def default_view_id(views: list[dict], role: str) -> Optional[str]:
    """The view a role opens first: the first is_default view (by position) whose audience has it."""
    mine = [v for v in views if role in v["audience"]]
    for v in mine:
        if v["is_default"]:
            return v["id"]
    return mine[0]["id"] if mine else None


# ── the filter (pure) ─────────────────────────────────────────────────────────

def matches(item: dict, filt: dict, *, me: str, role: str, delegated: tuple[str, ...] = ()) -> bool:
    """Does one already-scoped list item pass a view filter? ``item`` carries the internal keys
    _opened_by, _site_submitted_by, _site_assigned_to (see module_runtime_service.svc_list_records)."""
    f = ViewFilter.model_validate(filt or {})
    status = item.get("case_status")
    nxt = item.get("next_step") or {}
    assigned_to_me = me in (item.get("assigned_to"), item.get("_site_assigned_to"))
    created_by_me = me in (item.get("_opened_by"), item.get("_site_submitted_by"))
    checks = [
        (f.stage, lambda: item.get("current_stage") in f.stage),
        (f.status, lambda: status in f.status),
        (f.closed, lambda: (status in _CLOSED) == f.closed),
        (f.assigned_to_me, lambda: assigned_to_me == f.assigned_to_me),
        (f.created_by_me, lambda: created_by_me == f.created_by_me),
        (f.mine, lambda: (assigned_to_me or created_by_me or item["site"]["id"] in delegated) == f.mine),
        (f.awaiting, lambda: nxt.get("role") == (role if f.awaiting == "my_tier" else f.awaiting)),
        (f.actionable, lambda: bool(item.get("allowed_actions")) == f.actionable),
        (f.assigned, lambda: bool(item.get("assigned_to")) == f.assigned),
        (f.site_ids, lambda: item["site"]["id"].lower() in {s.lower() for s in f.site_ids}),
        (f.kind, lambda: nxt.get("kind") == f.kind),
    ]
    return all(test() for value, test in checks if value is not None)


# ── reads ─────────────────────────────────────────────────────────────────────

async def _views(session, tenant_id, module_key: str) -> list[dict]:
    rows = (await session.execute(text(f"""
        SELECT {_VIEW_COLS} FROM module_views
         WHERE tenant_id = :tid AND (module_key = :m OR module_key IS NULL) AND deleted_at IS NULL
         ORDER BY position, name, id
    """), {"tid": tenant_id, "m": module_key})).mappings().all()  # noqa: S608 — fixed column list
    return [view_out(r) for r in rows]


async def get_view_for(session, tenant_id, module_key: str, view_id: str, role: str) -> dict:
    """The view, if it belongs to this tenant + module (or all modules) and its audience has ``role``.
    Otherwise 404 — a view outside your audience does not exist for you."""
    row = (await session.execute(text(f"""
        SELECT {_VIEW_COLS} FROM module_views
         WHERE tenant_id = :tid AND id::text = :vid AND (module_key = :m OR module_key IS NULL)
           AND deleted_at IS NULL
    """), {"tid": tenant_id, "vid": view_id, "m": module_key})).mappings().first()  # noqa: S608
    if not row or role not in (row["audience"] or []):
        raise HTTPException(status_code=404, detail="View not found.")
    return view_out(row)


async def svc_list_views(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                         manage: bool = False) -> dict:
    """Views of this module for the caller's role (``manage=true``: every view, business admin only)."""
    from app.services import module_runtime_service as mrs

    reg = await mrs._custom_module(session, tenant_id, module_key)
    role = await mrs._actor_role(session, current_user, tenant_id, reg)   # real: may they manage?
    scope = mrs.view_role(current_user, role)  # F5a/E3: audience + default follow the effective role
    views = await _views(session, tenant_id, module_key)
    if manage and role != "business_admin":
        raise HTTPException(status_code=403, detail="Only a business admin can manage views.")
    shown = views if manage else [v for v in views if scope in v["audience"]]
    return {"module": {"key": reg["module_key"], "label": reg["label"]}, "role": role, "view_role": scope,
            "can_manage": role == "business_admin", "default_view_id": default_view_id(views, scope),
            "items": shown}


# ── commands (business admin) ─────────────────────────────────────────────────

async def _admin(session, tenant_id, current_user, module_key) -> dict:
    from app.services import module_runtime_service as mrs

    reg = await mrs._custom_module(session, tenant_id, module_key)
    if await mrs._actor_role(session, current_user, tenant_id, reg) != "business_admin":
        raise HTTPException(status_code=403, detail="Only a business admin can manage views.")
    return reg


async def _audit(session, *, tenant_id, current_user, action: str, view_id, module_key: str, detail: str,
                 prov: dict) -> None:
    await write_provenance_audit(
        session, tenant_id=tenant_id, actor_id=current_user["sub"], actor_name=current_user.get("name"),
        action=action, entity_id=view_id, entity_type="module_view", detail=detail, module_key=module_key,
        provenance={"policy": "views", **prov},
    )


async def svc_create_view(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                          body: ViewIn) -> dict:
    """Business admin: a new view for this module (or every custom module with ``all_modules``)."""
    async with transaction(session):
        await _admin(session, tenant_id, current_user, module_key)
        row = (await session.execute(text(f"""
            INSERT INTO module_views (tenant_id, module_key, name, filter, columns, audience, position,
                                      is_default, created_by)
            VALUES (:tid, :m, :name, CAST(:filter AS jsonb), CAST(:cols AS jsonb), :aud, :pos, :dflt, :uid)
            RETURNING {_VIEW_COLS}
        """), {"tid": tenant_id, "m": None if body.all_modules else module_key, "name": body.name,
               "filter": body.filter.model_dump_json(exclude_none=True), "cols": json.dumps(body.columns),
               "aud": list(dict.fromkeys(body.audience)), "pos": body.position, "dflt": body.is_default,
               "uid": current_user["sub"]})).mappings().one()  # noqa: S608
        out = view_out(row)
        await _audit(session, tenant_id=tenant_id, current_user=current_user, action="module_view_created",
                     view_id=out["id"], module_key=module_key, detail=out["name"], prov={"view": out})
    return out


async def _view_row_for_update(session, tenant_id, module_key, view_id):
    row = (await session.execute(text(f"""
        SELECT {_VIEW_COLS} FROM module_views
         WHERE tenant_id = :tid AND id::text = :vid AND (module_key = :m OR module_key IS NULL)
           AND deleted_at IS NULL
         FOR UPDATE
    """), {"tid": tenant_id, "vid": view_id, "m": module_key})).mappings().first()  # noqa: S608
    if not row:
        raise HTTPException(status_code=404, detail="View not found.")
    return row


async def svc_update_view(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                          view_id: str, patch: ViewPatch) -> dict:
    """Business admin: change name / filter / columns / audience / position / default of a view."""
    changes = patch.model_dump(exclude_unset=True)
    if not changes:
        raise ApiProblem(422, "Nothing to change.", code="empty_patch")
    async with transaction(session):
        await _admin(session, tenant_id, current_user, module_key)
        before = view_out(await _view_row_for_update(session, tenant_id, module_key, view_id))
        params: dict[str, Any] = {"tid": tenant_id, "vid": view_id}
        sets = ["updated_at = now()"]
        if "name" in changes:
            sets.append("name = :name")
            params["name"] = patch.name
        if "filter" in changes:
            sets.append("filter = CAST(:filter AS jsonb)")
            params["filter"] = (patch.filter or ViewFilter()).model_dump_json(exclude_none=True)
        if "columns" in changes:
            sets.append("columns = CAST(:cols AS jsonb)")
            params["cols"] = json.dumps(patch.columns or [])
        if "audience" in changes:
            sets.append("audience = :aud")
            params["aud"] = list(dict.fromkeys(patch.audience or []))
        if "position" in changes:
            sets.append("position = :pos")
            params["pos"] = patch.position
        if "is_default" in changes:
            sets.append("is_default = :dflt")
            params["dflt"] = bool(patch.is_default)
        row = (await session.execute(text(f"""
            UPDATE module_views SET {', '.join(sets)} WHERE tenant_id = :tid AND id::text = :vid
            RETURNING {_VIEW_COLS}
        """), params)).mappings().one()  # noqa: S608 — `sets` are fixed literals
        out = view_out(row)
        await _audit(session, tenant_id=tenant_id, current_user=current_user, action="module_view_updated",
                     view_id=out["id"], module_key=module_key, detail=out["name"],
                     prov={"before": before, "after": out})
    return out


async def svc_delete_view(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str,
                          view_id: str) -> None:
    """Soft delete: a removed default is not re-seeded by the next publish (reset restores it)."""
    async with transaction(session):
        await _admin(session, tenant_id, current_user, module_key)
        before = view_out(await _view_row_for_update(session, tenant_id, module_key, view_id))
        await session.execute(text("""
            UPDATE module_views SET deleted_at = now(), updated_at = now() WHERE tenant_id = :tid AND id::text = :vid
        """), {"tid": tenant_id, "vid": view_id})
        await _audit(session, tenant_id=tenant_id, current_user=current_user, action="module_view_deleted",
                     view_id=view_id, module_key=module_key, detail=before["name"], prov={"view": before})


async def svc_reset_views(session: AsyncSession, *, tenant_id, current_user: dict, module_key: str) -> dict:
    """Drop this module's views (not the all-module ones) and re-seed the defaults."""
    async with transaction(session):
        reg = await _admin(session, tenant_id, current_user, module_key)
        removed = (await session.execute(text("""
            DELETE FROM module_views WHERE tenant_id = :tid AND module_key = :m
        """), {"tid": tenant_id, "m": module_key})).rowcount
        seeded = (await session.execute(text("SELECT public.cfg_seed_module_views(:tid, :m)"),
                                        {"tid": tenant_id, "m": module_key})).scalar_one()
        await _audit(session, tenant_id=tenant_id, current_user=current_user, action="module_views_reset",
                     view_id=None, module_key=module_key, detail=f"{removed} removed, {seeded} seeded",
                     prov={"removed": removed, "seeded": seeded})
    out = await svc_list_views(session, tenant_id=tenant_id, current_user=current_user, module_key=module_key,
                               manage=True)
    out["reset"] = {"removed": removed, "seeded": seeded, "module": reg["module_key"]}
    return out
