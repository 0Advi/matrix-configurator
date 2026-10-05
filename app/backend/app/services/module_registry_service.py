"""Per-tenant module registry — the data-driven replacement for hard-coded module lists.

Phase 2 (configurator integration). Module vocabularies used to be spelled out in
five DB CHECKs and ~20 code locations (`Module = Literal[...]`, `_ORG_MODULES`,
`_SUPERVISOR_ONLY_MODULES`, `if module == "nso"` …). Migration 20261004_2 added
`module_catalog` (platform-owned built-ins) and `tenant_modules` (what THIS tenant
has: built-in or custom, label, position, enabled, supervisor_only,
delegation_enabled, route); 20261004_3 made every module column reference it.
This service is the one place the backend reads that registry.

Rules (also enforced by the callers listed in SANDBOX-CHANGES.md):
  * a module key must match ``is_valid_module_key`` (mirror of the SQL function);
  * a key a tenant has not registered does not exist for it (404);
  * a DISABLED module is hidden from org views, mints no codes, grants no new
    memberships and is refused by ``require_module`` (403);
  * membership-capable = custom modules + built-ins whose catalog row says
    ``has_membership`` (bd, legal, design, project_excellence, project, nso);
    retired (payment) and delegation-only scopes (quality_audit) never are.

Existing tenants keep today's behaviour: 20261004_2 backfilled every built-in,
enabled, with the catalog's defaults (nso supervisor-only).
"""
from __future__ import annotations

import re
from typing import Any, Optional
from uuid import UUID

from fastapi import HTTPException, status as http_status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


# Mirror of public.is_valid_module_key() (20261004_2) — the configurator's key rule.
_MODULE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,38}$")
_RESERVED_MODULE_KEYS: frozenset[str] = frozenset({
    "admin", "api", "new", "site", "sites", "user", "users",
    "module", "modules", "settings", "auth", "report", "reports",
})

# Where each built-in implementation lives in the SPA (frontend/src/router/routes.js).
# Used only when tenant_modules.route is NULL (seeded built-ins). Custom modules are
# served by the generic runtime under /m/<key>. finance_ca has no page of its own
# (it is the BD finance tab + the business-admin approval queue) -> route None.
_BUILTIN_ROUTES: dict[str, str] = {
    "bd": "/",
    "legal": "/legal",
    "design": "/design",
    "project_excellence": "/project-excellence",
    "project": "/project",
    "nso": "/nso",
    "launch_approval": "/launch",
    "financial_closure": "/project/financial-closure",
}


def is_valid_module_key(key: Any) -> bool:
    """True when ``key`` is a syntactically valid module key (shape only)."""
    return (
        isinstance(key, str)
        and bool(_MODULE_KEY_RE.match(key))
        and key not in _RESERVED_MODULE_KEYS
    )


def module_route(row: dict) -> Optional[str]:
    """The SPA route that serves a registry row.

    Custom modules always run on the generic runtime at ``/m/<key>``. Built-ins are served by
    their bespoke pages, so their route is the implementation's (``_BUILTIN_ROUTES``) — NOT the
    manifest's ``route`` (the configurator writes ``/<key>`` for built-ins, e.g. ``/pex`` or
    ``/finance-ca``, which the SPA does not have). ``tenant_modules.route`` keeps the
    manifest's value as configuration data only.
    """
    if row.get("kind") == "custom":
        return f"/m/{row['module_key']}"
    return _BUILTIN_ROUTES.get(row["module_key"])


_REGISTRY_SELECT = """
    SELECT tm.module_key, tm.kind, tm.catalog_key, tm.config_key, tm.label,
           tm.position, tm.enabled, tm.supervisor_only, tm.delegation_enabled,
           tm.route, tm.introduced_release_id, tm.updated_release_id,
           COALESCE(c.surface, 'module')   AS surface,
           c.implementation                 AS implementation,
           (c.retired_at IS NOT NULL)       AS retired,
           CASE WHEN tm.kind = 'custom' THEN true
                ELSE COALESCE(c.has_membership, false) END AS has_membership
      FROM tenant_modules tm
      LEFT JOIN module_catalog c ON c.key = tm.catalog_key
     WHERE tm.tenant_id = :tid
"""


def _row_out(r) -> dict:
    d = dict(r)
    d["route"] = module_route(d)
    return d


async def list_tenant_modules(
    session: AsyncSession,
    tenant_id: str | UUID,
    *,
    enabled_only: bool = True,
) -> list[dict]:
    """Registry rows of the tenant ordered by position (then key)."""
    sql = _REGISTRY_SELECT + (" AND tm.enabled" if enabled_only else "") + \
        " ORDER BY tm.position, tm.module_key"
    rows = (await session.execute(text(sql), {"tid": tenant_id})).mappings().all()
    return [_row_out(r) for r in rows]


async def get_tenant_module(
    session: AsyncSession, tenant_id: str | UUID, module_key: str,
) -> Optional[dict]:
    """One registry row (enabled or not), or None when the tenant has no such key."""
    if not is_valid_module_key(module_key):
        return None
    row = (await session.execute(
        text(_REGISTRY_SELECT + " AND tm.module_key = :key"),
        {"tid": tenant_id, "key": module_key},
    )).mappings().first()
    return _row_out(row) if row else None


def _is_membership_module(row: Optional[dict]) -> bool:
    return bool(
        row
        and row["surface"] == "module"
        and row["has_membership"]
        and not row["retired"]
    )


async def require_membership_module(
    session: AsyncSession, tenant_id: str | UUID, module_key: str,
) -> dict:
    """The registry row of an ENABLED, membership-capable module, else 404/403.

    Used before minting a department/invite code or granting a membership, so a
    disabled module gets no new codes or members and a module that has no
    supervisor/executive teams (finance_ca, launch_approval, scopes, retired keys)
    cannot be given one.
    """
    row = await get_tenant_module(session, tenant_id, module_key)
    if not _is_membership_module(row):
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail=f"Module '{module_key}' is not available in this workspace.",
        )
    if not row["enabled"]:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Module '{module_key}' is disabled in this workspace.",
        )
    return row


async def org_modules(session: AsyncSession, tenant_id: str | UUID) -> list[dict]:
    """Modules shown in the Departments org view: enabled + membership-capable,
    ordered by the tenant's position. For a tenant that never published a release
    this is the six built-in departments."""
    return [r for r in await list_tenant_modules(session, tenant_id) if _is_membership_module(r)]


async def membership_module_keys(
    session: AsyncSession, tenant_id: str | UUID, *, enabled_only: bool = True,
) -> set[str]:
    """Keys of the tenant's membership-capable modules (enabled ones by default)."""
    rows = await list_tenant_modules(session, tenant_id, enabled_only=enabled_only)
    return {r["module_key"] for r in rows if _is_membership_module(r)}


# ── Workspace navigation (GET /workspace/modules) ─────────────────────────────

async def svc_workspace_modules(
    session: AsyncSession, *, tenant_id: str | UUID, user_id: str | UUID,
) -> dict:
    """The tenant's ENABLED modules for navigation, plus the live release and the
    caller's own role(s) in each module. Tenant comes from the verified token."""
    live = (await session.execute(
        text("""
            SELECT l.release_id, r.version, l.activated_at, l.workspace_ref, r.manifest
              FROM tenant_config_live l
              JOIN tenant_config_releases r ON r.id = l.release_id
             WHERE l.tenant_id = :tid
        """),
        {"tid": tenant_id},
    )).mappings().first()
    memberships = (await session.execute(
        text("""
            SELECT DISTINCT module, role_in_module
              FROM user_module_memberships
             WHERE tenant_id = :tid AND user_id = :uid
        """),
        {"tid": tenant_id, "uid": user_id},
    )).mappings().all()
    my_roles: dict[str, list[str]] = {}
    for m in memberships:
        my_roles.setdefault(m["module"], []).append(m["role_in_module"])

    # The live manifest's per-module navigation (configurator sections/items), keyed by the
    # manifest key (= tenant_modules.config_key). Empty for a never-published tenant.
    nav_by_key: dict[str, list] = {}
    if live and isinstance(live["manifest"], dict):
        for m in live["manifest"].get("modules") or []:
            if isinstance(m, dict) and isinstance(m.get("key"), str):
                nav_by_key[m["key"]] = m.get("navigation") or []

    modules = []
    for r in await list_tenant_modules(session, tenant_id):
        if r["surface"] != "module" or r["retired"]:
            continue
        modules.append({
            "key": r["module_key"],
            "label": r["label"],
            "kind": r["kind"],
            "position": r["position"],
            "supervisor_only": r["supervisor_only"],
            "delegation_enabled": r["delegation_enabled"],
            "has_membership": r["has_membership"],
            "implementation": r["implementation"] or "generic",
            "route": r["route"],
            "my_roles": sorted(my_roles.get(r["module_key"], [])),
            "navigation": nav_by_key.get(r["config_key"] or r["module_key"], []),
        })
    return {
        "tenant_id": str(tenant_id),
        "release": None if not live else {
            "id": str(live["release_id"]),
            "version": live["version"],
            "activated_at": live["activated_at"].isoformat() if live["activated_at"] else None,
            "workspace_ref": live["workspace_ref"],
        },
        "modules": modules,
    }
