"""Platform workspaces — configurator provisioning + publishing (Phase 2, decisions D2/D3).

The Workspace Configurator lives in the platform-admin portal. For each configurator workspace
(its id = ``workspace_ref``) this service

* PROVISIONS a real tenant through the app's OWN provisioning path —
  ``tenancy_service.insert_workspace_request`` + ``tenancy_service.approve_workspace_request``,
  unchanged — so the tenant, workspace code, business admin, one-time setup token, outbox row
  and the approved workspace_requests row are exactly what a normally approved request gets.
  The configurator id is linked in ``platform_workspaces`` (migration 20261004_7), claimed
  BEFORE provisioning so two concurrent calls for one ref cannot create two tenants.
* PUBLISHES immutable releases: validate (``module_runtime.validate.check_manifest``: JSON
  Schema + gate compile/lint + form compile; refuse on errors), then in ONE transaction:
  INSERT tenant_config_releases (version n+1, publisher = the platform admin's email from the
  admin token, reason), ``cfg_activate_release()`` (projects the manifest onto tenant_modules and
  repoints tenant_config_live), stamp tenant_config_live.workspace_ref, and write an audit_logs
  row with provenance.

The platform credential never leaves the server; the only secret in any response is the one-
time admin setup token returned by provisioning.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import HTTPException, status as http_status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.problems import ApiProblem
from app.db.session import transaction
from app.services import module_registry_service as registry
from app.services import tenancy_service
from app.services.audit_service import write_provenance_audit
from app.services.module_runtime.validate import check_manifest

logger = logging.getLogger("matrix.platform")


# ── reads ─────────────────────────────────────────────────────────────────────

async def _catalog(session: AsyncSession) -> dict[str, dict]:
    rows = (await session.execute(text(
        "SELECT key, config_key, surface, retired_at IS NOT NULL AS retired FROM module_catalog"
    ))).mappings().all()
    return {r["key"]: {"config_key": r["config_key"], "surface": r["surface"], "retired": r["retired"]}
            for r in rows}


_WS_SELECT = """
    SELECT pw.workspace_ref, pw.status, pw.tenant_id, pw.workspace_request_id, pw.claimed_by,
           pw.created_at, pw.provisioned_at, pw.last_error,
           t.name AS company, t.workspace_code, t.seat_limit,
           (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS used_seats,
           l.release_id AS live_release_id, r.version AS live_version,
           l.activated_at AS live_activated_at, l.activated_by AS live_activated_by,
           (SELECT count(*) FROM tenant_config_releases x WHERE x.tenant_id = pw.tenant_id) AS release_count
      FROM platform_workspaces pw
      LEFT JOIN tenants t ON t.id = pw.tenant_id
      LEFT JOIN tenant_config_live l ON l.tenant_id = pw.tenant_id
      LEFT JOIN tenant_config_releases r ON r.id = l.release_id
"""


def _iso(v: Any) -> Optional[str]:
    return v.isoformat() if v is not None else None


def _ws_out(r) -> dict:
    return {
        "configurator_ref": r["workspace_ref"],
        "status": r["status"],
        "tenant_id": str(r["tenant_id"]) if r["tenant_id"] else None,
        "company": r["company"],
        "workspace_code": r["workspace_code"],
        "seat_limit": r["seat_limit"],
        "used_seats": r["used_seats"],
        "live_release": None if r["live_release_id"] is None else {
            "id": str(r["live_release_id"]),
            "version": r["live_version"],
            "activated_at": _iso(r["live_activated_at"]),
            "activated_by": r["live_activated_by"],
        },
        "release_count": r["release_count"] or 0,
        "provisioned_by": r["claimed_by"],
        "created_at": _iso(r["created_at"]),
        "provisioned_at": _iso(r["provisioned_at"]),
        "last_error": r["last_error"],
    }


async def svc_list_workspaces(session: AsyncSession) -> dict:
    """Every configurator-linked workspace with its live release."""
    rows = (await session.execute(text(_WS_SELECT + " ORDER BY pw.created_at DESC"))).mappings().all()
    return {"items": [_ws_out(r) for r in rows], "total": len(rows)}


async def _get_ws_row(session: AsyncSession, ref: str, *, for_update: bool = False):
    sql = _WS_SELECT + " WHERE pw.workspace_ref = :ref"
    if for_update:
        sql += " FOR UPDATE OF pw"
    return (await session.execute(text(sql), {"ref": ref})).mappings().first()


async def svc_get_workspace(session: AsyncSession, ref: str) -> dict:
    """One workspace: status, code, live release, release history, module registry, BA claim state."""
    row = await _get_ws_row(session, ref)
    if not row:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND,
                            detail=f"No workspace is linked to configurator id '{ref}'.")
    out = _ws_out(row)
    out["releases"] = []
    out["modules"] = []
    out["business_admin"] = None
    if row["tenant_id"]:
        rels = (await session.execute(text("""
            SELECT id, version, manifest_sha256, schema_version, reason, published_by, source,
                   source_ref, created_at
              FROM tenant_config_releases WHERE tenant_id = :tid ORDER BY version DESC
        """), {"tid": row["tenant_id"]})).mappings().all()
        out["releases"] = [{
            "id": str(r["id"]), "version": r["version"], "manifest_sha256": r["manifest_sha256"],
            "schema_version": r["schema_version"], "reason": r["reason"], "published_by": r["published_by"],
            "source": r["source"], "source_ref": r["source_ref"], "created_at": _iso(r["created_at"]),
            "is_live": row["live_release_id"] is not None and r["id"] == row["live_release_id"],
        } for r in rels]
        out["modules"] = [{
            "key": m["module_key"], "label": m["label"], "kind": m["kind"], "position": m["position"],
            "enabled": m["enabled"], "supervisor_only": m["supervisor_only"],
            "delegation_enabled": m["delegation_enabled"], "config_key": m["config_key"],
            "route": m["route"], "surface": m["surface"],
        } for m in await registry.list_tenant_modules(session, row["tenant_id"], enabled_only=False)]
        ba = (await session.execute(text("""
            SELECT u.email, u.name, (u.password_hash IS NOT NULL) AS has_password
              FROM business_admins b JOIN users u ON u.id = b.user_id
             WHERE b.tenant_id = :tid ORDER BY b.promoted_at LIMIT 1
        """), {"tid": row["tenant_id"]})).mappings().first()
        if ba:
            # has_password = whether the admin has claimed the account (set a first password).
            out["business_admin"] = {"email": ba["email"], "name": ba["name"], "has_password": ba["has_password"]}
    return out


async def svc_get_release(session: AsyncSession, ref: str, version: int) -> dict:
    """One release of the workspace, including its manifest."""
    row = await _get_ws_row(session, ref)
    if not row or not row["tenant_id"]:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND,
                            detail=f"No workspace is linked to configurator id '{ref}'.")
    rel = (await session.execute(text("""
        SELECT id, version, manifest, manifest_sha256, reason, published_by, source_ref, created_at
          FROM tenant_config_releases WHERE tenant_id = :tid AND version = :v
    """), {"tid": row["tenant_id"], "v": version})).mappings().first()
    if not rel:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=f"Release v{version} not found.")
    return {"id": str(rel["id"]), "version": rel["version"], "manifest": rel["manifest"],
            "manifest_sha256": rel["manifest_sha256"], "reason": rel["reason"],
            "published_by": rel["published_by"], "source_ref": rel["source_ref"],
            "created_at": _iso(rel["created_at"]),
            "is_live": row["live_release_id"] is not None and rel["id"] == row["live_release_id"]}


# ── provisioning ──────────────────────────────────────────────────────────────

async def _claim_ref(session: AsyncSession, ref: str, actor_email: str) -> Optional[str]:
    """Claim the configurator id (own transaction). 409 when it is taken or in flight.

    A claim stuck in 'provisioning' for more than 10 minutes (the process died between the
    claim and the approval commit) is treated like 'failed' and may be re-claimed.
    F5a: returns the workspace request an earlier attempt already created (or None), so the
    retry resumes it instead of creating a second request / a second tenant."""
    async with transaction(session):
        existing = (await session.execute(text("""
            SELECT status, workspace_request_id,
                   (status = 'provisioning' AND created_at < now() - interval '10 minutes') AS stale
              FROM platform_workspaces WHERE workspace_ref = :ref FOR UPDATE
        """), {"ref": ref})).mappings().first()
        if existing and existing["status"] != "failed" and not existing["stale"]:
            row = await _get_ws_row(session, ref)
            raise ApiProblem(
                http_status.HTTP_409_CONFLICT,
                f"Configurator workspace '{ref}' is already "
                f"{'provisioned' if existing['status'] == 'active' else 'being provisioned'}.",
                code="already_provisioned" if existing["status"] == "active" else "provisioning_in_progress",
                configurator_ref=ref,
                tenant_id=str(row["tenant_id"]) if row and row["tenant_id"] else None,
                workspace_code=row["workspace_code"] if row else None,
            )
        await session.execute(text("""
            INSERT INTO platform_workspaces (workspace_ref, status, claimed_by)
            VALUES (:ref, 'provisioning', :who)
            ON CONFLICT (workspace_ref) DO UPDATE
               SET status = 'provisioning', claimed_by = EXCLUDED.claimed_by,
                   last_error = NULL, created_at = now()
        """), {"ref": ref, "who": actor_email})
    prior = existing["workspace_request_id"] if existing else None
    return str(prior) if prior else None


async def _resume_point(session: AsyncSession, prior_request_id: Optional[str]) -> tuple[Optional[str], Optional[Any]]:
    """F5a: (pending request to approve, tenant an earlier attempt already provisioned) for a retry."""
    if not prior_request_id:
        return None, None
    row = (await session.execute(text(
        "SELECT status, provisioned_tenant_id FROM workspace_requests WHERE id = :rid"
    ), {"rid": prior_request_id})).mappings().first()
    await session.rollback()
    if row and row["status"] == "approved" and row["provisioned_tenant_id"]:
        return None, row["provisioned_tenant_id"]
    if row and row["status"] == "pending":
        return prior_request_id, None
    return None, None


async def _adopt_tenant(session: AsyncSession, tenant_id) -> dict:
    """F5a: the approval committed but the process died before the link: adopt that tenant (never a
    second one) and issue a fresh setup code — the first one was returned to a caller that is gone."""
    async with transaction(session):
        t = (await session.execute(text(
            "SELECT id, name, workspace_code, seat_limit FROM tenants WHERE id = :tid"
        ), {"tid": tenant_id})).mappings().one()
        try:
            code = await tenancy_service.reissue_admin_setup_code(session, tenant_id=tenant_id)
        except HTTPException as exc:
            if exc.status_code != http_status.HTTP_409_CONFLICT:
                raise
            code = None  # the admin already set a password (e.g. through a reset): nothing to hand out
        ba = (await session.execute(text("""
            SELECT u.id, u.email FROM business_admins b JOIN users u ON u.id = b.user_id
             WHERE b.tenant_id = :tid ORDER BY b.promoted_at LIMIT 1
        """), {"tid": tenant_id})).mappings().first()
    return {"tenant_id": t["id"], "workspace_code": t["workspace_code"], "seat_limit": t["seat_limit"],
            "business_admin_id": ba["id"] if ba else None, "admin_email": ba["email"] if ba else None,
            "admin_setup_token": code["token"] if code else None, "company": t["name"], "recovered": True}


async def svc_provision_workspace(
    session: AsyncSession,
    *,
    ref: str,
    company: str,
    admin_email: str,
    admin_name: Optional[str],
    seat_limit: Optional[int],
    team_size: Optional[str],
    city: Optional[str],
    source_ip: Optional[str],
    actor_email: str,
) -> dict:
    """Provision a tenant for configurator workspace ``ref`` via the app's own approval path.

    Idempotency on ``ref``: a second call answers 409 ``already_provisioned`` carrying the
    existing tenant_id / workspace_code (never the setup token again). A failed attempt can be
    retried with the same ref.
    """
    prior_request = await _claim_ref(session, ref, actor_email)
    try:
        # F5a: a retry after a crash resumes the earlier attempt — approve its still-pending request,
        # or adopt the tenant its committed approval created — instead of provisioning a second one.
        request_id, adopted = await _resume_point(session, prior_request)
        if adopted is not None:
            request_id = prior_request
            result = await _adopt_tenant(session, adopted)
        else:
            if request_id is None:
                request_id = await tenancy_service.insert_workspace_request(
                    session,
                    company=company,
                    admin_email=admin_email,
                    team_size=team_size,
                    seat_limit=seat_limit if seat_limit is not None else tenancy_service._parse_seat_limit(team_size),
                    source_ip=source_ip,
                )
                async with transaction(session):  # remember it BEFORE approving (crash-safe retry)
                    await session.execute(text(
                        "UPDATE platform_workspaces SET workspace_request_id = :rid WHERE workspace_ref = :ref"
                    ), {"rid": request_id, "ref": ref})
            result = await tenancy_service.approve_workspace_request(
                session, request_id=str(request_id), admin_name=admin_name, city=city,
            )
    except Exception as exc:
        await session.rollback()
        async with transaction(session):
            await session.execute(text("""
                UPDATE platform_workspaces SET status = 'failed', last_error = :err
                 WHERE workspace_ref = :ref
            """), {"ref": ref, "err": str(getattr(exc, "detail", exc))[:500]})
        raise

    async with transaction(session):
        await session.execute(text("""
            UPDATE platform_workspaces
               SET status = 'active', tenant_id = :tid, workspace_request_id = :rid,
                   provisioned_at = now(), last_error = NULL
             WHERE workspace_ref = :ref
        """), {"ref": ref, "tid": result["tenant_id"], "rid": request_id})
        await write_provenance_audit(
            session, tenant_id=result["tenant_id"], actor_name=actor_email,
            action="workspace_provisioned_from_configurator",
            entity_id=result["tenant_id"], entity_type="tenant",
            detail=f"configurator workspace {ref}",
            provenance={"policy": "provision", "configurator_ref": ref,
                        "workspace_request_id": str(request_id), "actor": "platform_admin",
                        **({"recovered": True} if result.get("recovered") else {})},
        )
    logger.info("platform: provisioned configurator workspace ref=%s tenant=%s", ref, result["tenant_id"])
    return {
        "configurator_ref": ref,
        "tenant_id": str(result["tenant_id"]),
        "workspace_code": result["workspace_code"],
        "seat_limit": result["seat_limit"],
        "business_admin_id": str(result["business_admin_id"]) if result.get("business_admin_id") else None,
        "admin_email": result["admin_email"],
        "admin_setup_token": result["admin_setup_token"],
        "workspace_request_id": str(request_id),
        "live_release": None,
        "recovered": bool(result.get("recovered")),
        "message": (
            (f"Resumed an interrupted provisioning of {result['company']} (no second tenant was created; a new "
             f"setup code replaces the lost one). " if result.get("recovered") else
             f"Provisioned {result['company']}. ")
            + f"Share the workspace code AND the one-time setup code "
            f"with {result['admin_email']} — they set their password on the login page with it. "
            f"The setup code is shown only once. Publish a release to apply the configuration."
        ),
    }


async def svc_reissue_admin_setup_code(session: AsyncSession, *, ref: str, actor_email: str) -> dict:
    """F5a / SEC-1: a fresh one-time setup code for the workspace's UNCLAIMED business admin.

    For when the provisioning code was lost (e.g. G1's agent-coffee run never stored it).
    One transaction: lock the admin's user row, refuse if a password is already set (409),
    supersede older codes, store only the new code's hash, audit who re-issued it."""
    async with transaction(session):
        row = await _get_ws_row(session, ref)
        if not row or not row["tenant_id"]:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND,
                                detail=f"No workspace is linked to configurator id '{ref}'.")
        if row["status"] != "active":
            raise HTTPException(status_code=http_status.HTTP_409_CONFLICT,
                                detail=f"Workspace '{ref}' is {row['status']}, not active.")
        out = await tenancy_service.reissue_admin_setup_code(session, tenant_id=row["tenant_id"])
        await write_provenance_audit(
            session, tenant_id=row["tenant_id"], actor_name=actor_email,
            action="business_admin_setup_code_reissued",
            entity_id=out["user_id"], entity_type="user",
            detail=f"configurator workspace {ref}",
            provenance={"policy": "setup_code_reissue", "configurator_ref": ref,
                        "actor": "platform_admin", "expires_at": out["expires_at"]},
        )
    logger.info("platform: re-issued BA setup code ref=%s tenant=%s", ref, row["tenant_id"])
    return {
        "configurator_ref": ref,
        "tenant_id": str(row["tenant_id"]),
        "workspace_code": row["workspace_code"],
        "admin_email": out["email"],
        "admin_setup_token": out["token"],
        "expires_at": _iso(out["expires_at"]),
        "message": (
            f"New one-time setup code for {out['email']}. Earlier codes no longer work. "
            f"Share it privately — it is shown only once."
        ),
    }


# ── publishing ────────────────────────────────────────────────────────────────

async def svc_validate_manifest(session: AsyncSession, *, ref: Optional[str], manifest: Any) -> dict:
    """Dry run of the publish checks (no writes)."""
    report = check_manifest(manifest, catalog=await _catalog(session), workspace_ref=ref)
    await session.rollback()
    return report


async def svc_publish_release(
    session: AsyncSession,
    *,
    ref: str,
    manifest: Any,
    reason: Optional[str],
    source_ref: Optional[str],
    actor_email: str,
) -> dict:
    """Validate, then store + activate the next release in one transaction (see module doc)."""
    report = check_manifest(manifest, catalog=await _catalog(session), workspace_ref=ref)
    await session.rollback()  # release the catalog read before the write transaction
    if not report["ok"]:
        raise ApiProblem(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"The manifest has {report['errors']} error(s); nothing was published.",
            code="manifest_invalid", findings=report["findings"],
        )

    async with transaction(session):
        ws = await _get_ws_row(session, ref, for_update=True)
        if not ws:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND,
                                detail=f"No workspace is linked to configurator id '{ref}'. Provision it first.")
        if ws["status"] != "active":
            raise ApiProblem(http_status.HTTP_409_CONFLICT,
                             f"Workspace '{ref}' is {ws['status']}; it cannot take a release yet.",
                             code="workspace_not_active")
        tenant_id = ws["tenant_id"]
        version = (await session.execute(text(
            "SELECT coalesce(max(version), 0) + 1 FROM tenant_config_releases WHERE tenant_id = :tid"
        ), {"tid": tenant_id})).scalar_one()
        rel = (await session.execute(text("""
            INSERT INTO tenant_config_releases
                (tenant_id, version, manifest, reason, published_by, source, source_ref)
            VALUES (:tid, :v, CAST(:m AS jsonb), :reason, :who, 'configurator', :sref)
            RETURNING id, version, manifest_sha256, created_at
        """), {"tid": tenant_id, "v": version, "m": json.dumps(manifest), "reason": reason,
               "who": actor_email, "sref": source_ref})).mappings().one()
        projected = (await session.execute(text("SELECT public.cfg_activate_release(:rid, :who)"),
                                           {"rid": rel["id"], "who": actor_email})).scalar_one()
        await session.execute(text(
            "UPDATE tenant_config_live SET workspace_ref = :ref WHERE tenant_id = :tid"
        ), {"ref": ref, "tid": tenant_id})
        await write_provenance_audit(
            session, tenant_id=tenant_id, actor_name=actor_email,
            action="config_release_published",
            entity_id=rel["id"], entity_type="tenant_config_release",
            detail=f"v{rel['version']}" + (f": {reason}" if reason else ""),
            config_release_id=rel["id"],
            provenance={"policy": "publish", "version": rel["version"],
                        "manifest_sha256": rel["manifest_sha256"], "configurator_ref": ref,
                        "previous_release_id": str(ws["live_release_id"]) if ws["live_release_id"] else None,
                        "source_ref": source_ref, "warnings": report["warnings"],
                        "modules_projected": projected, "actor": "platform_admin"},
        )
    logger.info("platform: published v%s for ref=%s tenant=%s", rel["version"], ref, tenant_id)
    modules = [{
        "key": m["module_key"], "label": m["label"], "kind": m["kind"], "position": m["position"],
        "enabled": m["enabled"], "supervisor_only": m["supervisor_only"], "route": m["route"],
    } for m in await registry.list_tenant_modules(session, tenant_id, enabled_only=False)
        if m["surface"] == "module" and not m["retired"]]
    return {
        "configurator_ref": ref,
        "tenant_id": str(tenant_id),
        "release": {"id": str(rel["id"]), "version": rel["version"], "manifest_sha256": rel["manifest_sha256"],
                    "published_by": actor_email, "reason": reason, "source_ref": source_ref,
                    "created_at": _iso(rel["created_at"])},
        "findings": report["findings"],
        "modules": modules,
    }
