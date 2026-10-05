"""Role-scoped saved views of custom-module pages (Phase 2b, G3 #4).

Thin HTTP surface over services/module_views_service.py. Tenant from the token; the caller's role
is the role the generic runtime acts with (business_admin / observer workspace-wide, otherwise the
module membership tier). Everyone in the module reads the views whose audience has their role;
business admins manage them. A view is applied with ``GET /m/{key}/records?view=<id>``.

- GET    /m/{module_key}/views[?manage=true]   views for my role (+ default_view_id); manage = all (BA)
- POST   /m/{module_key}/views                 create (business admin)
- PATCH  /m/{module_key}/views/{view_id}       edit (business admin)
- DELETE /m/{module_key}/views/{view_id}       remove (business admin; soft delete)
- POST   /m/{module_key}/views/reset           restore this module's default views (business admin)
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.core.deps import DbDep, TenantId
from app.domain.schemas.module_views import ViewIn, ViewPatch
from app.rbac.guards import require_role
from app.rbac.roles import Role
from app.services import module_views_service as svc

router = APIRouter(prefix="/m", tags=["Custom modules — saved views"])

ModuleUser = Annotated[dict, Depends(require_role(Role.SUPERVISOR, Role.EXECUTIVE))]
ModuleKey = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{1,38}$")]
ViewId = Annotated[str, Path(pattern=r"^[0-9a-fA-F-]{36}$")]


@router.get("/{module_key}/views", summary="Saved views of a custom module for my role")
async def list_views(module_key: ModuleKey, db: DbDep, current_user: ModuleUser, tenant_id: TenantId,
                     manage: bool = Query(default=False, description="every view (business admin)")) -> dict:
    return await svc.svc_list_views(db, tenant_id=tenant_id, current_user=current_user,
                                    module_key=module_key, manage=manage)


@router.post("/{module_key}/views", status_code=status.HTTP_201_CREATED, summary="Business admin: create a view")
async def create_view(module_key: ModuleKey, body: ViewIn, db: DbDep, current_user: ModuleUser,
                      tenant_id: TenantId) -> dict:
    return await svc.svc_create_view(db, tenant_id=tenant_id, current_user=current_user,
                                     module_key=module_key, body=body)


@router.post("/{module_key}/views/reset", summary="Business admin: restore the default views of this module")
async def reset_views(module_key: ModuleKey, db: DbDep, current_user: ModuleUser, tenant_id: TenantId) -> dict:
    return await svc.svc_reset_views(db, tenant_id=tenant_id, current_user=current_user, module_key=module_key)


@router.patch("/{module_key}/views/{view_id}", summary="Business admin: edit a view")
async def update_view(module_key: ModuleKey, view_id: ViewId, body: ViewPatch, db: DbDep,
                      current_user: ModuleUser, tenant_id: TenantId) -> dict:
    return await svc.svc_update_view(db, tenant_id=tenant_id, current_user=current_user,
                                     module_key=module_key, view_id=view_id, patch=body)


@router.delete("/{module_key}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT,
               summary="Business admin: remove a view")
async def delete_view(module_key: ModuleKey, view_id: ViewId, db: DbDep, current_user: ModuleUser,
                      tenant_id: TenantId) -> None:
    await svc.svc_delete_view(db, tenant_id=tenant_id, current_user=current_user,
                              module_key=module_key, view_id=view_id)
