"""Platform-admin router for configurator workspaces (Phase 2, decisions D1–D3).

Thin HTTP surface over services/platform_workspace_service.py. Every route is guarded
by the platform-admin JWT in ``X-Platform-Admin-Key`` (minted by
POST /tenancy/admin/login, 30-minute TTL) — the same authority as the existing
/tenancy/requests/* routes. The key never appears in a response.

- POST /platform/workspaces                         provision a tenant for a configurator workspace
- GET  /platform/workspaces                         list configurator-linked workspaces
- GET  /platform/workspaces/{ref}                   status, live version, release history, modules
- POST /platform/workspaces/{ref}/releases          validate + publish a manifest (new version)
- POST /platform/workspaces/{ref}/releases/validate dry-run of the publish checks
- GET  /platform/workspaces/{ref}/releases/{version} one release incl. its manifest
- POST /platform/workspaces/{ref}/migrations        G3: dry-run / execute "migrate running cases"
- GET  /platform/workspaces/{ref}/migrations        G3: executed migrations (newest first)
- GET  /platform/workspaces/{ref}/migrations/{id}   G3: one migration incl. its journal items
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Optional, Union

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.core.deps import DbDep
from app.core.security import decode_admin_token
from app.services import platform_workspace_service as svc
from app.services import release_migration_service as migration_svc

router = APIRouter(prefix="/platform", tags=["Platform workspaces"])

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_REF_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"


def platform_admin(
    x_platform_admin_key: Annotated[Optional[str], Header(alias="X-Platform-Admin-Key")] = None,
) -> dict:
    """Verify the platform-admin JWT; returns {"email": ...} (the publisher identity)."""
    if not x_platform_admin_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Missing X-Platform-Admin-Key header.")
    try:
        return decode_admin_token(x_platform_admin_key)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid or expired admin token — please log in again.")


PlatformAdmin = Annotated[dict, Depends(platform_admin)]
Ref = Annotated[str, Path(pattern=_REF_PATTERN, description="configurator workspace id")]


class ProvisionIn(BaseModel):
    configurator_ref: str = Field(pattern=_REF_PATTERN, description="the configurator's workspace id")
    company:          str = Field(min_length=1, max_length=200)
    admin_email:      str = Field(min_length=3, max_length=254)
    admin_name:       Optional[str] = Field(default=None, max_length=120)
    seat_limit:       Optional[int] = Field(default=None, ge=1, le=10000)
    team_size:        Optional[str] = Field(default=None, max_length=64)
    city:             Optional[str] = Field(default=None, max_length=80)

    @field_validator("admin_email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("admin_email must be a valid email address")
        return v


class PublishIn(BaseModel):
    manifest:   dict[str, Any]
    reason:     Optional[str] = Field(default=None, max_length=500)
    source_ref: Optional[str] = Field(default=None, max_length=200,
                                      description="design-time release id (e.g. NocoBase cfg_releases id)")


class ValidateIn(BaseModel):
    manifest: dict[str, Any]


@router.post("/workspaces", status_code=status.HTTP_201_CREATED,
             summary="Platform admin: provision a tenant for a configurator workspace")
async def provision_workspace(body: ProvisionIn, request: Request, db: DbDep, admin: PlatformAdmin) -> dict:
    return await svc.svc_provision_workspace(
        db, ref=body.configurator_ref, company=body.company.strip(), admin_email=body.admin_email,
        admin_name=body.admin_name, seat_limit=body.seat_limit, team_size=body.team_size,
        city=body.city, source_ip=request.client.host if request.client else None,
        actor_email=admin["email"],
    )


@router.get("/workspaces", summary="Platform admin: configurator-linked workspaces")
async def list_workspaces(db: DbDep, _admin: PlatformAdmin) -> dict:
    return await svc.svc_list_workspaces(db)


@router.get("/workspaces/{ref}", summary="Platform admin: one workspace — status, live version, releases")
async def get_workspace(ref: Ref, db: DbDep, _admin: PlatformAdmin) -> dict:
    return await svc.svc_get_workspace(db, ref)


@router.post("/workspaces/{ref}/releases", status_code=status.HTTP_201_CREATED,
             summary="Platform admin: validate and publish a manifest as the next release")
async def publish_release(ref: Ref, body: PublishIn, db: DbDep, admin: PlatformAdmin) -> dict:
    return await svc.svc_publish_release(
        db, ref=ref, manifest=body.manifest, reason=body.reason, source_ref=body.source_ref,
        actor_email=admin["email"],
    )


@router.post("/workspaces/{ref}/releases/validate",
             summary="Platform admin: run the publish checks without publishing")
async def validate_release(ref: Ref, body: ValidateIn, db: DbDep, _admin: PlatformAdmin) -> dict:
    return await svc.svc_validate_manifest(db, ref=ref, manifest=body.manifest)


@router.get("/workspaces/{ref}/releases/{version}", summary="Platform admin: one release incl. manifest")
async def get_release(ref: Ref, version: Annotated[int, Path(ge=1)], db: DbDep, _admin: PlatformAdmin) -> dict:
    return await svc.svc_get_release(db, ref, version)


# ── G3 #2: migrate running cases ──────────────────────────────────────────────

_UUID = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
_MODULE = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,38}$")]


class MigrationScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    module_keys: Optional[list[_MODULE]] = Field(default=None, max_length=50)
    site_ids:    Optional[list[_UUID]] = Field(default=None, max_length=500)
    record_ids:  Optional[list[_UUID]] = Field(default=None, max_length=500)


class MigrateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_release_version: Union[Annotated[int, Field(ge=1)], Literal["all_older"]] = "all_older"
    to_release_version:   Optional[Annotated[int, Field(ge=1)]] = Field(default=None, description="default: live")
    scope:  MigrationScope = Field(default_factory=MigrationScope)
    reason: Optional[str] = Field(default=None, max_length=500, description="required when dry_run=false")
    dry_run: bool = True
    stage_map: Optional[dict[_MODULE, dict[str, Optional[int]]]] = Field(
        default=None, description='{module_key: {"<from stage order>": <to stage order> | null}}')
    restart_stage_on_chain_change: bool = False


@router.post("/workspaces/{ref}/migrations",
             summary="Platform admin: dry-run or execute a migration of running custom-module cases")
async def migrate_running_cases(ref: Ref, body: MigrateIn, db: DbDep, admin: PlatformAdmin) -> dict:
    return await migration_svc.svc_migrate_running_cases(
        db, ref=ref, actor_email=admin["email"],
        from_version=body.from_release_version if body.from_release_version != "all_older" else None,
        all_older=body.from_release_version == "all_older", to_version=body.to_release_version,
        scope=body.scope.model_dump(exclude_none=True), reason=body.reason, dry_run=body.dry_run,
        options={"stage_map": body.stage_map or {},
                 "restart_stage_on_chain_change": body.restart_stage_on_chain_change},
    )


@router.get("/workspaces/{ref}/migrations", summary="Platform admin: executed migrations of running cases")
async def list_migrations(ref: Ref, db: DbDep, _admin: PlatformAdmin) -> dict:
    return await migration_svc.svc_list_migrations(db, ref)


@router.get("/workspaces/{ref}/migrations/{migration_id}", summary="Platform admin: one migration + journal")
async def get_migration(ref: Ref, migration_id: Annotated[str, Path(pattern=r"^[0-9a-fA-F-]{36}$")],
                        db: DbDep, _admin: PlatformAdmin) -> dict:
    return await migration_svc.svc_get_migration(db, ref, migration_id)
