"""Generic custom-module runtime router (Phase 2, decision D4).

Thin HTTP surface over services/module_runtime_service.py. Serves every CUSTOM module of the
tenant's published configuration under /m/{module_key}; built-in modules keep their bespoke
routers. Tenant always comes from the verified token; module membership is checked per request
in the service (not from the JWT's single module claim), so one user can work in several modules.

- GET  /m/{module_key}/members                       active supervisors/executives (assign picker)
- GET  /m/{module_key}/records[?site_id=][&view=]    cases (+ site_gate when site_id is given; G3: saved view)
- POST /m/{module_key}/records                       open the case for a site (409 gate_closed)
- GET  /m/{module_key}/records/{record_id}           case detail: pinned release, stages, form, actions, gate, audit
- POST /m/{module_key}/records/{record_id}/actions   submit | approve | reject | send_back
- POST /m/{module_key}/records/{record_id}/assign    supervisor/admin assigns the case to an executive
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, status
from pydantic import BaseModel, Field, model_validator

from app.core.deps import DbDep, TenantId
from app.rbac.guards import require_role
from app.rbac.roles import Role
from app.services import module_runtime_service as svc

router = APIRouter(prefix="/m", tags=["Custom modules"])

# business_admin / observer pass require_role via READ_ALL_ROLES; observers are refused writes by
# get_current_user. Membership in the specific module is checked by the service.
ModuleUser = Annotated[dict, Depends(require_role(Role.SUPERVISOR, Role.EXECUTIVE))]
ModuleKey = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{1,38}$")]
RecordId = Annotated[str, Path(pattern=r"^[0-9a-fA-F-]{36}$")]


class OpenRecordIn(BaseModel):
    site_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")


class ActionIn(BaseModel):
    action: Literal["submit", "approve", "reject", "send_back"]
    values: Optional[dict[str, Any]] = None
    # `note` is accepted as an alias of `reason` (required for reject / send_back).
    reason: Optional[str] = Field(default=None, max_length=2000)
    note: Optional[str] = Field(default=None, max_length=2000)
    to_stage: Optional[int] = Field(default=None, ge=1)
    expected_seq: Optional[int] = Field(default=None, ge=0,
                                        description="optimistic check: the record.seq the client acted on")

    @model_validator(mode="after")
    def _note_alias(self) -> "ActionIn":
        if self.reason is None and self.note is not None:
            self.reason = self.note
        return self


class AssignIn(BaseModel):
    executive_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")


@router.get("/{module_key}/members", summary="Active supervisors/executives of a custom module")
async def list_members(module_key: ModuleKey, db: DbDep, current_user: ModuleUser, tenant_id: TenantId) -> dict:
    return await svc.svc_list_members(db, tenant_id=tenant_id, current_user=current_user, module_key=module_key)


@router.get("/{module_key}/records", summary="Cases of a custom module (optionally for one site / one saved view)")
async def list_records(module_key: ModuleKey, db: DbDep, current_user: ModuleUser, tenant_id: TenantId,
                       site_id: Optional[str] = Query(default=None, pattern=r"^[0-9a-fA-F-]{36}$"),
                       view: Optional[str] = Query(default=None, pattern=r"^[0-9a-fA-F-]{36}$",
                                                   description="saved view id (GET /m/{key}/views); applied "
                                                               "server-side on top of the caller's scope")) -> dict:
    return await svc.svc_list_records(db, tenant_id=tenant_id, current_user=current_user,
                                      module_key=module_key, site_id=site_id, view_id=view)


@router.post("/{module_key}/records", status_code=status.HTTP_201_CREATED,
             summary="Open the module's case for a site (refused while its entry gate is closed)")
async def open_record(module_key: ModuleKey, body: OpenRecordIn, db: DbDep, current_user: ModuleUser,
                      tenant_id: TenantId) -> dict:
    return await svc.svc_open_record(db, tenant_id=tenant_id, current_user=current_user,
                                     module_key=module_key, site_id=body.site_id)


@router.get("/{module_key}/records/{record_id}", summary="One case: stages, form, allowed actions, gate, audit")
async def get_record(module_key: ModuleKey, record_id: RecordId, db: DbDep, current_user: ModuleUser,
                     tenant_id: TenantId) -> dict:
    return await svc.svc_get_record(db, tenant_id=tenant_id, current_user=current_user,
                                    module_key=module_key, record_id=record_id)


@router.post("/{module_key}/records/{record_id}/actions", summary="Act on the case's current step")
async def act(module_key: ModuleKey, record_id: RecordId, body: ActionIn, db: DbDep,
              current_user: ModuleUser, tenant_id: TenantId) -> dict:
    return await svc.svc_act(db, tenant_id=tenant_id, current_user=current_user, module_key=module_key,
                             record_id=record_id, action=body.action, values=body.values,
                             reason=body.reason, to_stage=body.to_stage, expected_seq=body.expected_seq)


@router.post("/{module_key}/records/{record_id}/assign", summary="Assign the case to an executive (delegation)")
async def assign(module_key: ModuleKey, record_id: RecordId, body: AssignIn, db: DbDep,
                 current_user: ModuleUser, tenant_id: TenantId) -> dict:
    return await svc.svc_assign(db, tenant_id=tenant_id, current_user=current_user, module_key=module_key,
                                record_id=record_id, executive_id=body.executive_id)
