"""Workspace configuration router (Phase 2 — configurator integration).

Thin HTTP surface over services/module_registry_service.py.

- GET /workspace/modules — any signed-in user: the tenant's ENABLED modules
  (built-in + custom) with label / kind / position / supervisor_only / route and
  the caller's own role(s) in each, plus the live configuration release. Drives
  the data-driven navigation. Tenant always comes from the verified token.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.deps import CurrentUser, DbDep, TenantId
from app.services import module_registry_service as registry

router = APIRouter(prefix="/workspace", tags=["Workspace"])


class WorkspaceModuleOut(BaseModel):
    key: str
    label: str
    kind: str                      # builtin | custom
    position: int
    supervisor_only: bool
    delegation_enabled: bool
    has_membership: bool           # has supervisor/executive teams (dept codes)
    implementation: str            # builtin:<name> | generic (custom runtime)
    route: Optional[str] = None    # SPA route; custom modules -> /m/<key>
    my_roles: list[str] = []       # caller's role_in_module values in this module
    navigation: list[dict] = []    # live manifest's navigation sections for this module (may be [])


class LiveReleaseOut(BaseModel):
    id: str
    version: int
    activated_at: Optional[str] = None
    workspace_ref: Optional[str] = None


class WorkspaceModulesOut(BaseModel):
    tenant_id: str
    release: Optional[LiveReleaseOut] = None   # null = legacy (never published)
    modules: list[WorkspaceModuleOut]


@router.get(
    "/modules",
    response_model=WorkspaceModulesOut,
    summary="Signed-in: the workspace's enabled modules (navigation) + live release",
)
async def workspace_modules(db: DbDep, current_user: CurrentUser, tenant_id: TenantId) -> dict:
    return await registry.svc_workspace_modules(
        db, tenant_id=tenant_id, user_id=current_user["sub"],
    )
