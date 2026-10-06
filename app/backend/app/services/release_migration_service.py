"""Audited "migrate running cases" (Phase 2b, G3 #2) — platform-admin action.

Moves in-flight custom-module cases of a configurator workspace from the release they are pinned to
(vN, or every older release) onto release vM (default: live) — the hot-fix path next to version
pinning. Idea: the user's operaton-plat ``op_migrate_running`` (process-instance migration).

What moves (and why both): the runtime resolves a case's rules from ``module_records.release_id``
and a NEW case's rules from ``sites.config_release_id``; F2's guards require record release = site
pin on every write. So a migration moves the SITE PIN and EVERY in-flight custom-module record on
that site together — the unit of atomicity is the site: one transaction per site, site row then its
records locked FOR UPDATE, every in-flight record re-planned under the lock; if any of them is
incompatible the whole site is skipped (never half-migrated). Finished cases keep the release they
finished on. Records of modules outside the requested scope that share a moving site are
``co_migrated`` (reported as such) — they must be compatible too.

Controlled path (migration 20261005_1): a header row (``module_release_migrations``, reason +
platform-admin email) and, per site, append-only ``module_release_migration_items`` (site pin + each
record, with the FULL pre-migration runtime_state) are written first; the transaction-local setting
``matrix.release_migration`` = header id is what lets the pin triggers accept exactly those moves.
Every other UPDATE of a pin is refused by the DB.

Audit: per record ``module_release_migrated`` (entity = the case, so it shows in the case audit
trail) with a hash-chained ``release_migrated`` runtime event + provenance {from_release,
to_release, actor, reason, before/after stage, mapping, fields, approvals carried, pre_state}; per
site ``site_release_migrated``; per migration ``release_migration_executed``.
Dry run (default) writes nothing.

F5a (robustness): an executing migration stamps a heartbeat + progress into its header's
``summary`` after every site; a header still ``running`` whose heartbeat is older than
``STALE_AFTER_SECONDS`` (the process died mid-run) is marked ``failed`` — on app startup, before the
next execute of that tenant — with a recovery note; committed sites are never touched (each site
was its own transaction; the journal shows which moved). A second execute for a tenant whose
migration is still live is refused (409 ``migration_in_progress``). Optional
``include_idle_sites``: also re-pin sites pinned to a source release that have NO running case
(journal item + ``site_release_migrated`` audit, policy ``idle``); finished cases keep the release
they finished on. Default off (G3 behaviour).
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from fastapi import HTTPException, status as http_status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.problems import ApiProblem
from app.db.session import transaction
from app.services import module_runtime_service as mrs
from app.services.audit_service import write_provenance_audit
from app.services.module_runtime import migrate, runtime

logger = logging.getLogger("matrix.release_migration")


# A running migration whose heartbeat is older than this is treated as dead (F5a). Every site is
# one short transaction followed by a heartbeat, so 10 minutes without one means the process stopped.
STALE_AFTER_SECONDS = 600

_STALE_SQL = """coalesce((m.summary->>'heartbeat_at')::timestamptz, m.created_at)
                < now() - make_interval(secs => :stale)"""


class _SiteSkipped(Exception):
    """Raised inside a site's transaction to roll it back and report the site as skipped."""

    def __init__(self, reason: str, items: list[dict]):
        super().__init__(reason)
        self.reason, self.items = reason, items


# ── resolution ────────────────────────────────────────────────────────────────

async def _workspace(session: AsyncSession, ref: str) -> dict:
    ws = (await session.execute(text("""
        SELECT pw.workspace_ref, pw.status, pw.tenant_id, l.release_id AS live_release_id
          FROM platform_workspaces pw
          LEFT JOIN tenant_config_live l ON l.tenant_id = pw.tenant_id
         WHERE pw.workspace_ref = :ref
    """), {"ref": ref})).mappings().first()
    if not ws:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND,
                            detail=f"No workspace is linked to configurator id '{ref}'.")
    if ws["status"] != "active":
        raise ApiProblem(http_status.HTTP_409_CONFLICT, f"Workspace '{ref}' is {ws['status']}.",
                         code="workspace_not_active")
    return dict(ws)


async def _releases(session: AsyncSession, tenant_id) -> dict[int, dict]:
    rows = (await session.execute(text("""
        SELECT id, version, manifest_sha256 FROM tenant_config_releases WHERE tenant_id = :tid ORDER BY version
    """), {"tid": tenant_id})).mappings().all()
    return {r["version"]: {"id": str(r["id"]), "version": r["version"], "manifest_sha256": r["manifest_sha256"]}
            for r in rows}


def _target_and_sources(rels: dict[int, dict], ws: dict, *, from_version: Optional[int], all_older: bool,
                        to_version: Optional[int]) -> tuple[dict, list[int], str]:
    if not rels:
        raise ApiProblem(http_status.HTTP_409_CONFLICT, "This workspace has no published release.", code="no_release")
    if to_version is None:
        live = next((r for r in rels.values() if r["id"] == str(ws["live_release_id"])), None)
        if live is None:
            raise ApiProblem(http_status.HTTP_409_CONFLICT, "This workspace has no live release.", code="no_release")
        to_version = live["version"]
    if to_version not in rels:
        raise ApiProblem(http_status.HTTP_404_NOT_FOUND, f"Release v{to_version} does not exist.", code="unknown_release")
    if all_older:
        sources = [v for v in rels if v < to_version]
        spec = "all_older"
    else:
        if from_version not in rels:
            raise ApiProblem(http_status.HTTP_404_NOT_FOUND, f"Release v{from_version} does not exist.",
                             code="unknown_release")
        if from_version == to_version:
            raise ApiProblem(http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                             "The source and target release are the same.", code="same_release")
        sources = [from_version]
        spec = f"v{from_version}"
    return rels[to_version], sources, spec


_RECORD_COLS = """
    r.id, r.site_id, r.module_key, r.release_id, r.runtime_state, r.status, r.current_stage, r.exit_outcome,
    r.assigned_to, rel.version AS release_version, s.config_release_id AS site_pin,
    s.name AS site_name, s.code AS site_code, s.ca_code
"""


async def _candidates(session, tenant_id, versions: list[int], scope: dict) -> list[dict]:
    where = ["r.tenant_id = :tid", "rel.version = ANY(:versions)"]
    params: dict[str, Any] = {"tid": tenant_id, "versions": versions}
    if scope.get("module_keys"):
        where.append("r.module_key = ANY(:mods)")
        params["mods"] = list(scope["module_keys"])
    if scope.get("site_ids"):
        where.append("r.site_id::text = ANY(:sites)")
        params["sites"] = [str(s) for s in scope["site_ids"]]
    if scope.get("record_ids"):
        where.append("r.id::text = ANY(:recs)")
        params["recs"] = [str(s) for s in scope["record_ids"]]
    rows = (await session.execute(text(f"""
        SELECT {_RECORD_COLS}
          FROM module_records r
          JOIN sites s ON s.id = r.site_id
          JOIN tenant_config_releases rel ON rel.id = r.release_id
         WHERE {' AND '.join(where)}
         ORDER BY s.name, r.module_key
    """), params)).mappings().all()  # noqa: S608 — `where` is built from fixed literals only
    return [dict(r) for r in rows]


async def _site_records(session, tenant_id, site_ids: list[str], *, lock: bool = False) -> list[dict]:
    rows = (await session.execute(text(f"""
        SELECT {_RECORD_COLS}
          FROM module_records r
          JOIN sites s ON s.id = r.site_id
          JOIN tenant_config_releases rel ON rel.id = r.release_id
         WHERE r.tenant_id = :tid AND r.site_id::text = ANY(:sites)
         ORDER BY r.id
         {'FOR UPDATE OF r' if lock else ''}
    """), {"tid": tenant_id, "sites": site_ids})).mappings().all()  # noqa: S608
    return [dict(r) for r in rows]


# ── planning ──────────────────────────────────────────────────────────────────

def _in_flight(rec: dict) -> bool:
    return (rec["runtime_state"] or {}).get("status") in migrate.IN_FLIGHT


async def _plan_record(session, tenant_id, rec: dict, target: dict, opts: dict) -> dict:
    """Plan one record (source runtime from ITS release, target runtime from the target release)."""
    src_rel = await mrs.load_release(session, tenant_id, rec["release_id"])
    dst_rel = await mrs.load_release(session, tenant_id, target["id"])
    src_def = mrs.module_def(src_rel, rec["module_key"])
    dst_def = mrs.module_def(dst_rel, rec["module_key"])
    state = rec["runtime_state"] or {}
    src_rt = mrs.runtime_for(src_rel, src_def)
    dst_rt = mrs.runtime_for(dst_rel, dst_def) if dst_def else None
    p = migrate.plan(state, src_rt, dst_rt, target_enabled=bool(dst_def and dst_def.get("enabled", True)),
                     target_version=target["version"],
                     stage_map=(opts.get("stage_map") or {}).get(rec["module_key"]),
                     restart_stage_on_chain_change=bool(opts.get("restart_stage_on_chain_change")))
    if p["in_flight"] and str(state.get("release")) != str(rec["release_id"]):
        p["blocking"].append(migrate._issue("state_release_mismatch",
                                            "The case state does not belong to its pinned release."))
        p["compatible"] = False
    return {"plan": p, "src_rel": src_rel, "dst_rel": dst_rel, "src_rt": src_rt, "dst_rt": dst_rt,
            "dst_def": dst_def}


def _item_out(rec: dict, planned: dict, *, target: dict, co_migrated: bool, outcome: str,
              approvals: int, message: Optional[str] = None) -> dict:
    p = planned["plan"]
    return {
        "record_id": str(rec["id"]), "module_key": rec["module_key"],
        "site": {"id": str(rec["site_id"]), "name": rec["site_name"], "code": rec["ca_code"] or rec["site_code"]},
        "from_version": rec["release_version"], "to_version": target["version"],
        "case_status": p["case_status"], "in_flight": p["in_flight"], "compatible": p["compatible"],
        "co_migrated": co_migrated, "outcome": outcome, "blocking": p["blocking"], "warnings": p["warnings"],
        "stage": {"before": p["before"], "after": p["after"]}, "stage_mapping": p["stage_mapping"],
        "fields": p["fields"], "approvals_carried": approvals, "message": message,
    }


async def _approval_counts(session, record_ids: list[str]) -> dict[str, int]:
    if not record_ids:
        return {}
    rows = (await session.execute(text("""
        SELECT record_id::text AS rid, count(*) AS n FROM module_approvals
         WHERE record_id::text = ANY(:ids) GROUP BY record_id
    """), {"ids": record_ids})).mappings().all()
    return {r["rid"]: r["n"] for r in rows}


async def _plan_sites(session, tenant_id, *, candidates: list[dict], sources: list[int], target: dict,
                      opts: dict) -> tuple[dict[str, dict], list[dict]]:
    """-> ({site_id: {site, records:[(rec, planned, co_migrated)]}}, items for closed in-scope cases)."""
    scoped_ids = {str(c["id"]) for c in candidates}
    site_ids = sorted({str(c["site_id"]) for c in candidates if _in_flight(c)})
    approvals = await _approval_counts(session, list(scoped_ids))
    closed_items = []
    for c in candidates:
        if not _in_flight(c):
            planned = await _plan_record(session, tenant_id, c, target, opts)
            closed_items.append(_item_out(c, planned, target=target, co_migrated=False, outcome="not_in_flight",
                                          approvals=approvals.get(str(c["id"]), 0)))
    sites: dict[str, dict] = {}
    for rec in await _site_records(session, tenant_id, site_ids):
        if not _in_flight(rec):
            continue
        sid = str(rec["site_id"])
        planned = await _plan_record(session, tenant_id, rec, target, opts)
        p = planned["plan"]
        if rec["release_version"] not in sources:
            p["blocking"].append(migrate._issue(
                "other_release", f"Shares the site but runs on v{rec['release_version']}, outside this migration."))
            p["compatible"] = False
        if str(rec["site_pin"]) != str(rec["release_id"]):
            p["blocking"].append(migrate._issue("inconsistent_pin", "The site is pinned to another release."))
            p["compatible"] = False
        sites.setdefault(sid, {"site_id": sid, "records": []})["records"].append(
            (rec, planned, str(rec["id"]) not in scoped_ids))
    return sites, closed_items


def _site_verdict(site: dict) -> tuple[bool, list[dict]]:
    blocked = [r for r, pl, _ in site["records"] if not pl["plan"]["compatible"]]
    issues = [migrate._issue("site_blocked", f"Another running case on this site ({r['module_key']}) cannot move; "
                                             "the site and all its cases stay together.") for r in blocked]
    return not blocked, issues


# ── execution (one transaction per site) ──────────────────────────────────────

async def _write_stage_rows(session, *, tenant_id, record_id, dst_rt: runtime.ModuleRuntime, new_state: dict,
                            mapping: list[dict]) -> None:
    old = {r["stage_order"]: r for r in (await session.execute(text("""
        SELECT stage_order, submitted_by, submitted_at, decided_at FROM module_stage_states WHERE record_id = :rid
    """), {"rid": record_id})).mappings().all()}
    inverse = {m["to"]["order"]: m["from"]["order"] for m in mapping if m["to"]}
    for st in dst_rt.stages:
        src = old.get(inverse.get(st["order"])) if st["order"] in inverse else None
        await session.execute(text("""
            INSERT INTO module_stage_states
                (record_id, stage_order, tenant_id, stage_name, status, field_values,
                 submitted_by, submitted_at, decided_at)
            VALUES (:rid, :o, :tid, :name, :status, CAST(:vals AS jsonb), :sby, :sat, :dat)
            ON CONFLICT (record_id, stage_order) DO UPDATE
               SET stage_name = EXCLUDED.stage_name, status = EXCLUDED.status,
                   field_values = EXCLUDED.field_values, submitted_by = EXCLUDED.submitted_by,
                   submitted_at = EXCLUDED.submitted_at, decided_at = EXCLUDED.decided_at
        """), {"rid": record_id, "o": st["order"], "tid": tenant_id, "name": st["name"],
               "status": mrs._stage_status(new_state, st),
               "vals": json.dumps(new_state["values"].get(str(st["order"]), {})),
               "sby": src["submitted_by"] if src else None, "sat": src["submitted_at"] if src else None,
               "dat": src["decided_at"] if src else None})


async def _migrate_site(session, *, tenant_id, mig_id: str, site_id: str, target: dict, sources: list[int],
                        scoped_ids: set[str], opts: dict, actor_email: str, reason: str) -> list[dict]:
    """One locked transaction: re-plan under the locks, journal, move the pin + records, audit."""
    async with transaction(session):
        await session.execute(text("SELECT set_config('matrix.release_migration', :mid, true)"), {"mid": mig_id})
        site = (await session.execute(text("""
            SELECT id, config_release_id, name FROM sites WHERE id = CAST(:sid AS uuid) AND tenant_id = :tid FOR UPDATE
        """), {"sid": site_id, "tid": tenant_id})).mappings().first()
        if not site:
            raise _SiteSkipped("site no longer exists", [])
        recs = await _site_records(session, tenant_id, [site_id], lock=True)
        moving = [r for r in recs if _in_flight(r)]
        approvals = await _approval_counts(session, [str(r["id"]) for r in moving])
        planned_all = []
        for rec in moving:
            planned = await _plan_record(session, tenant_id, rec, target, opts)
            if rec["release_version"] not in sources or str(rec["site_pin"]) != str(rec["release_id"]):
                planned["plan"]["compatible"] = False
                planned["plan"]["blocking"].append(migrate._issue("changed", "The case moved or changed release."))
            planned_all.append((rec, planned))
        if not moving or any(not pl["plan"]["compatible"] for _, pl in planned_all):
            items = [_item_out(r, pl, target=target, co_migrated=str(r["id"]) not in scoped_ids,
                               outcome="skipped", approvals=approvals.get(str(r["id"]), 0),
                               message="re-checked under lock: not compatible any more")
                     for r, pl in planned_all]
            raise _SiteSkipped("a case on this site is no longer compatible" if moving else "no running case left",
                               items)
        from_release_id = str(site["config_release_id"])
        prepared = []
        for rec, planned in planned_all:
            p = planned["plan"]
            src_rel = planned["src_rel"]
            ev_payload = {"migration_id": mig_id, "reason": reason,
                          "from": {"release": src_rel["id"], "version": src_rel["version"]},
                          "to": {"release": target["id"], "version": target["version"]},
                          "before": p["before"], "after": p["after"]}
            new_state, ev = migrate.apply(rec["runtime_state"], planned["dst_rt"], p,
                                          actor=runtime.Actor(id=actor_email, role="platform_admin"),
                                          payload=ev_payload)
            prepared.append((rec, planned, new_state, ev))
        # 1. journal first — the pin triggers only accept moves an item authorises
        await session.execute(text("""
            INSERT INTO module_release_migration_items
                (migration_id, tenant_id, site_id, from_release_id, to_release_id, plan)
            VALUES (:mid, :tid, CAST(:sid AS uuid), :frm, :to, CAST(:plan AS jsonb))
        """), {"mid": mig_id, "tid": tenant_id, "sid": site_id, "frm": from_release_id, "to": target["id"],
               "plan": json.dumps({"records": [str(r["id"]) for r, *_ in prepared]})})
        for rec, planned, new_state, _ev in prepared:
            p = planned["plan"]
            await session.execute(text("""
                INSERT INTO module_release_migration_items
                    (migration_id, tenant_id, site_id, record_id, module_key, from_release_id, to_release_id,
                     before_stage, after_stage, before_state, after_state, plan)
                VALUES (:mid, :tid, CAST(:sid AS uuid), :rid, :mod, :frm, :to, CAST(:bs AS jsonb), CAST(:as_ AS jsonb),
                        CAST(:bst AS jsonb), CAST(:ast AS jsonb), CAST(:plan AS jsonb))
            """), {"mid": mig_id, "tid": tenant_id, "sid": site_id, "rid": rec["id"], "mod": rec["module_key"],
                   "frm": str(rec["release_id"]), "to": target["id"], "bs": json.dumps(p["before"]),
                   "as_": json.dumps(p["after"]), "bst": json.dumps(rec["runtime_state"]),
                   "ast": json.dumps(new_state),
                   "plan": json.dumps({k: p[k] for k in ("stage_mapping", "fields", "warnings")}
                                      | {"co_migrated": str(rec["id"]) not in scoped_ids})})
        # 2. the site pin, then every running case on it
        await session.execute(text("UPDATE sites SET config_release_id = :to WHERE id = CAST(:sid AS uuid)"),
                              {"to": target["id"], "sid": site_id})
        out = []
        for rec, planned, new_state, ev in prepared:
            p = planned["plan"]
            row = runtime.module_record_row(new_state, (planned["dst_def"] or {}).get("exit_signal"))
            await session.execute(text("""
                UPDATE module_records
                   SET release_id = :to, runtime_state = CAST(:state AS jsonb),
                       status = :status, current_stage = :stage, exit_outcome = :exit
                 WHERE id = :rid
            """), {"to": target["id"], "state": json.dumps(new_state), "status": row["status"],
                   "stage": row["current_stage"], "exit": row["exit_outcome"], "rid": rec["id"]})
            await _write_stage_rows(session, tenant_id=tenant_id, record_id=rec["id"], dst_rt=planned["dst_rt"],
                                    new_state=new_state, mapping=p["stage_mapping"])
            co = str(rec["id"]) not in scoped_ids
            await write_provenance_audit(
                session, tenant_id=tenant_id, site_id=site_id, actor_name=actor_email,
                action="module_release_migrated", entity_id=rec["id"], entity_type="module_record",
                detail=f"{rec['module_key']} v{planned['src_rel']['version']} -> v{target['version']}: {reason}",
                config_release_id=target["id"], module_key=rec["module_key"],
                provenance={"policy": "release_migration", "migration_id": mig_id,
                            "from_release": {"id": planned["src_rel"]["id"], "version": planned["src_rel"]["version"]},
                            "to_release": {"id": target["id"], "version": target["version"]},
                            "release_version": target["version"], "manifest_sha256": target["manifest_sha256"],
                            "actor": actor_email, "actor_kind": "platform_admin", "reason": reason,
                            "before_stage": p["before"], "after_stage": p["after"],
                            "stage_mapping": p["stage_mapping"], "fields": p["fields"],
                            "warnings": p["warnings"], "approvals_carried": approvals.get(str(rec["id"]), 0),
                            "co_migrated": co, "pre_state": rec["runtime_state"], "event": ev},
            )
            out.append(_item_out(rec, planned, target=target, co_migrated=co, outcome="migrated",
                                 approvals=approvals.get(str(rec["id"]), 0)))
        await write_provenance_audit(
            session, tenant_id=tenant_id, site_id=site_id, actor_name=actor_email,
            action="site_release_migrated", entity_id=site_id, entity_type="site",
            detail=f"site pin v{prepared[0][1]['src_rel']['version']} -> v{target['version']}: {reason}",
            config_release_id=target["id"],
            provenance={"policy": "release_migration", "migration_id": mig_id, "from": from_release_id,
                        "to": target["id"], "release_version": target["version"], "actor": actor_email,
                        "reason": reason, "records": [str(r["id"]) for r, *_ in prepared]},
        )
    return out


# ── F5a: crash recovery, heartbeat, one live migration per tenant ─────────────

_RECOVERY_NOTE = ("The process running this migration stopped before it finished. Sites listed in its "
                  "journal were migrated (each in its own committed transaction); no other site or case was "
                  "touched. Run the migration again to move the rest.")


async def recover_stale_migrations(session: AsyncSession, *, tenant_id=None,
                                   stale_after_seconds: int = STALE_AFTER_SECONDS) -> list[dict]:
    """Mark migrations stuck in 'running' (no heartbeat for ``stale_after_seconds``) as 'failed'.

    Own transaction. Touches only the header (status/summary/finished_at — the only mutable columns
    while running) plus one audit row per recovered migration; never a site, record or journal item.
    Safe with several app instances: a live migration heartbeats after every site.
    """
    tenant_clause = "AND m.tenant_id = CAST(:tid AS uuid)" if tenant_id is not None else ""
    async with transaction(session):
        rows = (await session.execute(text(f"""
            UPDATE module_release_migrations m
               SET status = 'failed', finished_at = now(),
                   summary = coalesce(m.summary, '{{}}'::jsonb) || jsonb_build_object(
                       'recovered', true, 'recovered_at', now(), 'failure', CAST(:note AS text),
                       'journal', jsonb_build_object(
                           'sites', (SELECT count(*) FROM module_release_migration_items i
                                      WHERE i.migration_id = m.id AND i.record_id IS NULL),
                           'records', (SELECT count(*) FROM module_release_migration_items i
                                        WHERE i.migration_id = m.id AND i.record_id IS NOT NULL)))
             WHERE m.status = 'running' AND {_STALE_SQL} {tenant_clause}
            RETURNING m.id, m.tenant_id, m.to_release_id, m.summary
        """), {"note": _RECOVERY_NOTE, "stale": stale_after_seconds,
               **({"tid": str(tenant_id)} if tenant_id is not None else {})})).mappings().all()  # noqa: S608
        for r in rows:
            await write_provenance_audit(
                session, tenant_id=r["tenant_id"], actor_name="system",
                action="release_migration_recovered", entity_id=r["id"], entity_type="module_release_migration",
                detail="stale running migration marked failed (process stopped mid-run)",
                config_release_id=r["to_release_id"],
                provenance={"policy": "release_migration", "migration_id": str(r["id"]), "actor": "system",
                            "recovered": True, "journal": (r["summary"] or {}).get("journal")},
            )
    for r in rows:
        logger.warning("release migration %s (tenant %s) was left running; marked failed", r["id"], r["tenant_id"])
    return [{"id": str(r["id"]), "tenant_id": str(r["tenant_id"])} for r in rows]


async def _refuse_if_live_migration(session: AsyncSession, tenant_id) -> None:
    live = (await session.execute(text(f"""
        SELECT m.id FROM module_release_migrations m
         WHERE m.tenant_id = :tid AND m.status = 'running' AND NOT ({_STALE_SQL})
         LIMIT 1
    """), {"tid": tenant_id, "stale": STALE_AFTER_SECONDS})).mappings().first()  # noqa: S608
    if live:
        raise ApiProblem(http_status.HTTP_409_CONFLICT,
                         "Another migration of this workspace is still running. Wait for it to finish.",
                         code="migration_in_progress", migration_id=str(live["id"]))


async def _heartbeat(session: AsyncSession, mig_id: str, *, done: int, total: int) -> None:
    await session.rollback()
    async with transaction(session):
        await session.execute(text("""
            UPDATE module_release_migrations
               SET summary = jsonb_build_object('progress', jsonb_build_object('sites_done', CAST(:d AS int),
                                                                                'sites_total', CAST(:t AS int)),
                                                'heartbeat_at', now())
             WHERE id = :id AND status = 'running'
        """), {"d": done, "t": total, "id": mig_id})


async def _mark_failed(session: AsyncSession, mig_id: str, exc: BaseException) -> None:
    """Best effort: an unexpected error mid-run marks the header failed instead of leaving it running."""
    try:
        await session.rollback()
        async with transaction(session):
            await session.execute(text("""
                UPDATE module_release_migrations
                   SET status = 'failed', finished_at = now(),
                       summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('failure', CAST(:f AS text))
                 WHERE id = :id AND status = 'running'
            """), {"id": mig_id, "f": f"aborted: {type(exc).__name__}"})
    except Exception:  # noqa: BLE001 — recover_stale_migrations() catches what this cannot
        logger.exception("release migration %s: could not mark it failed", mig_id)


# ── F5a: idle sites (pinned to a source release, no running case) ──────────────

async def _idle_sites(session, tenant_id, versions: list[int], scope: dict) -> list[dict]:
    if scope.get("record_ids") or not versions:
        return []  # a record-targeted migration never re-pins idle sites
    where = ["s.tenant_id = :tid", "rel.version = ANY(:versions)"]
    params: dict[str, Any] = {"tid": tenant_id, "versions": versions, "inflight": list(migrate.IN_FLIGHT)}
    if scope.get("site_ids"):
        where.append("s.id::text = ANY(:sites)")
        params["sites"] = [str(x) for x in scope["site_ids"]]
    rows = (await session.execute(text(f"""
        SELECT s.id, s.name, s.code, s.ca_code, s.config_release_id, rel.version AS from_version,
               (SELECT count(*) FROM module_records r WHERE r.site_id = s.id) AS finished_cases
          FROM sites s JOIN tenant_config_releases rel ON rel.id = s.config_release_id
         WHERE {' AND '.join(where)}
           AND NOT EXISTS (SELECT 1 FROM module_records r
                            WHERE r.site_id = s.id AND (r.runtime_state->>'status') = ANY(:inflight))
         ORDER BY s.name
    """), params)).mappings().all()  # noqa: S608 — `where` is built from fixed literals only
    return [dict(r) for r in rows]


def _idle_out(site: dict, target: dict, outcome: str, message: Optional[str] = None) -> dict:
    return {"site": {"id": str(site["id"]), "name": site["name"], "code": site["ca_code"] or site["code"]},
            "from_version": site["from_version"], "to_version": target["version"],
            "finished_cases": site["finished_cases"], "outcome": outcome, "message": message}


async def _repin_idle_site(session, *, tenant_id, mig_id: str, site: dict, target: dict, sources: list[int],
                           actor_email: str, reason: str) -> dict:
    """One locked transaction: re-check (still on a source release, still no running case), journal, move."""
    async with transaction(session):
        await session.execute(text("SELECT set_config('matrix.release_migration', :mid, true)"), {"mid": mig_id})
        cur = (await session.execute(text("""
            SELECT s.config_release_id, rel.version FROM sites s
              JOIN tenant_config_releases rel ON rel.id = s.config_release_id
             WHERE s.id = :sid AND s.tenant_id = :tid FOR UPDATE OF s
        """), {"sid": site["id"], "tid": tenant_id})).mappings().first()
        recs = await _site_records(session, tenant_id, [str(site["id"])], lock=True)
        if not cur or cur["version"] not in sources or any(_in_flight(r) for r in recs):
            raise _SiteSkipped("changed since the dry run (moved, or a case was opened)", [])
        await session.execute(text("""
            INSERT INTO module_release_migration_items
                (migration_id, tenant_id, site_id, from_release_id, to_release_id, plan)
            VALUES (:mid, :tid, :sid, :frm, :to, CAST(:plan AS jsonb))
        """), {"mid": mig_id, "tid": tenant_id, "sid": site["id"], "frm": cur["config_release_id"],
               "to": target["id"], "plan": json.dumps({"idle": True, "records": [],
                                                       "finished_cases": [str(r["id"]) for r in recs]})})
        await session.execute(text("UPDATE sites SET config_release_id = :to WHERE id = :sid"),
                              {"to": target["id"], "sid": site["id"]})
        await write_provenance_audit(
            session, tenant_id=tenant_id, site_id=site["id"], actor_name=actor_email,
            action="site_release_migrated", entity_id=site["id"], entity_type="site",
            detail=f"idle site pin v{cur['version']} -> v{target['version']}: {reason}",
            config_release_id=target["id"],
            provenance={"policy": "release_migration", "idle": True, "migration_id": mig_id,
                        "from": str(cur["config_release_id"]), "to": target["id"],
                        "release_version": target["version"], "actor": actor_email, "reason": reason,
                        "finished_cases_stay": [str(r["id"]) for r in recs]},
        )
    return _idle_out(site, target, "repinned")


async def _execute_idle(session, *, tenant_id, mig_id, idle: list[dict], target, sources, actor_email,
                        reason) -> list[dict]:
    out = []
    for site in idle:
        await session.rollback()
        try:
            out.append(await _repin_idle_site(session, tenant_id=tenant_id, mig_id=mig_id, site=site,
                                              target=target, sources=sources, actor_email=actor_email,
                                              reason=reason))
        except _SiteSkipped as sk:
            await session.rollback()
            out.append(_idle_out(site, target, "skipped", sk.reason))
        except Exception as exc:  # noqa: BLE001 — one failing site must not stop the others
            await session.rollback()
            logger.exception("release migration %s: idle site %s failed", mig_id, site["id"])
            out.append(_idle_out(site, target, "failed", f"database refused the move: {type(exc).__name__}"))
    return out


def _idle_summary(idle_items: list[dict]) -> dict:
    by: dict[str, int] = {}
    for i in idle_items:
        by[i["outcome"]] = by.get(i["outcome"], 0) + 1
    return {"total": len(idle_items), "by_outcome": by}


# ── the command ───────────────────────────────────────────────────────────────

def _summary(items: list[dict]) -> dict:
    by = {}
    for i in items:
        by[i["outcome"]] = by.get(i["outcome"], 0) + 1
    return {"records": len(items), "sites": len({i["site"]["id"] for i in items}),
            "compatible": sum(1 for i in items if i["compatible"]),
            "blocked": sum(1 for i in items if i["in_flight"] and not i["compatible"]),
            "by_outcome": by}


async def svc_migrate_running_cases(
    session: AsyncSession, *, ref: str, actor_email: str, from_version: Optional[int], all_older: bool,
    to_version: Optional[int], scope: dict, reason: Optional[str], dry_run: bool, options: dict,
) -> dict:
    """Dry-run (default) or execute a migration of running custom-module cases (see module doc)."""
    reason = (reason or "").strip()
    if not dry_run and len(reason) < 3:
        raise ApiProblem(http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                         "A reason (at least 3 characters) is required to migrate running cases.",
                         code="reason_required")
    ws = await _workspace(session, ref)
    tenant_id = ws["tenant_id"]
    rels = await _releases(session, tenant_id)
    target, sources, spec = _target_and_sources(rels, ws, from_version=from_version, all_older=all_older,
                                                to_version=to_version)
    candidates = await _candidates(session, tenant_id, sources, scope) if sources else []
    sites, closed_items = await _plan_sites(session, tenant_id, candidates=candidates, sources=sources,
                                            target=target, opts=options)
    scoped_ids = {str(c["id"]) for c in candidates}
    head = {"configurator_ref": ref, "tenant_id": str(tenant_id), "dry_run": dry_run,
            "from": {"spec": spec, "versions": sources}, "to": {"id": target["id"], "version": target["version"]},
            "scope": scope, "options": options, "reason": reason or None, "actor": actor_email}

    include_idle = bool(options.get("include_idle_sites"))
    idle = await _idle_sites(session, tenant_id, sources, scope) if include_idle else []

    if dry_run:
        items = list(closed_items)
        for site in sites.values():
            ok, issues = _site_verdict(site)
            approvals = await _approval_counts(session, [str(r["id"]) for r, *_ in site["records"]])
            for rec, planned, co in site["records"]:
                pl = planned["plan"]
                if pl["compatible"] and not ok:
                    pl["blocking"] = pl["blocking"] + issues
                    pl["compatible"] = False
                items.append(_item_out(rec, planned, target=target, co_migrated=co,
                                       outcome="would_migrate" if pl["compatible"] else "blocked",
                                       approvals=approvals.get(str(rec["id"]), 0)))
        await session.rollback()
        out = {**head, "migration_id": None, "summary": _summary(items), "items": items}
        if include_idle:
            out["idle_sites"] = [_idle_out(x, target, "would_repin") for x in idle]
            out["summary"]["idle_sites"] = _idle_summary(out["idle_sites"])
        return out

    await session.rollback()  # end the planning reads before the write transactions
    await recover_stale_migrations(session, tenant_id=tenant_id)
    mig_id = str(uuid.uuid4())
    async with transaction(session):
        # one live migration per tenant: serialise check + insert (released at commit)
        await session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                              {"k": f"release_migration:{tenant_id}"})
        await _refuse_if_live_migration(session, tenant_id)
        await session.execute(text("""
            INSERT INTO module_release_migrations (id, tenant_id, to_release_id, from_spec, scope, reason, actor)
            VALUES (:id, :tid, :to, :spec, CAST(:scope AS jsonb), :reason, :actor)
        """), {"id": mig_id, "tid": tenant_id, "to": target["id"], "spec": spec,
               "scope": json.dumps({**scope, "options": options}), "reason": reason, "actor": actor_email})
    try:
        items, idle_items = await _execute_all(
            session, tenant_id=tenant_id, mig_id=mig_id, sites=sites, idle=idle, closed_items=closed_items,
            target=target, sources=sources, scoped_ids=scoped_ids, options=options, actor_email=actor_email,
            reason=reason)
        summary = _summary(items)
        if include_idle:
            summary["idle_sites"] = _idle_summary(idle_items)
        await _finish(session, tenant_id=tenant_id, mig_id=mig_id, summary=summary, spec=spec, target=target,
                      scope=scope, actor_email=actor_email, reason=reason)
    except BaseException as exc:
        await _mark_failed(session, mig_id, exc)
        raise
    logger.info("release migration %s for ref=%s: %s", mig_id, ref, summary)
    out = {**head, "migration_id": mig_id, "summary": summary, "items": items}
    if include_idle:
        out["idle_sites"] = idle_items
    return out


async def _execute_all(session, *, tenant_id, mig_id, sites: dict, idle: list[dict], closed_items: list[dict],
                       target, sources, scoped_ids, options, actor_email, reason) -> tuple[list[dict], list[dict]]:
    """Every site in its own transaction (running cases first, then idle sites), heartbeat after each."""
    items = list(closed_items)
    total, done = len(sites) + len(idle), 0
    for site_id, site in sites.items():
        await session.rollback()
        try:
            items += await _migrate_site(session, tenant_id=tenant_id, mig_id=mig_id, site_id=site_id,
                                         target=target, sources=sources, scoped_ids=scoped_ids, opts=options,
                                         actor_email=actor_email, reason=reason)
        except _SiteSkipped as sk:
            await session.rollback()
            listed = {i["record_id"] for i in sk.items}
            items += sk.items
            for rec, planned, co in site["records"]:  # cases skipped at plan time (none were locked)
                if str(rec["id"]) not in listed:
                    items.append(_item_out(rec, planned, target=target, co_migrated=co, outcome="skipped",
                                           approvals=0, message=sk.reason))
        except Exception as exc:  # noqa: BLE001 — one failing site must not stop the others
            await session.rollback()
            logger.exception("release migration %s: site %s failed", mig_id, site_id)
            for rec, planned, co in site["records"]:
                items.append(_item_out(rec, planned, target=target, co_migrated=co, outcome="failed",
                                       approvals=0, message=f"database refused the move: {type(exc).__name__}"))
        done += 1
        await _heartbeat(session, mig_id, done=done, total=total)
    idle_items = []
    for site in idle:
        idle_items += await _execute_idle(session, tenant_id=tenant_id, mig_id=mig_id, idle=[site], target=target,
                                          sources=sources, actor_email=actor_email, reason=reason)
        done += 1
        await _heartbeat(session, mig_id, done=done, total=total)
    return items, idle_items


async def _finish(session, *, tenant_id, mig_id, summary, spec, target, scope, actor_email, reason) -> None:
    await session.rollback()
    async with transaction(session):
        await session.execute(text("""
            UPDATE module_release_migrations SET status = 'done', summary = CAST(:s AS jsonb), finished_at = now()
             WHERE id = :id
        """), {"s": json.dumps(summary), "id": mig_id})
        await write_provenance_audit(
            session, tenant_id=tenant_id, actor_name=actor_email, action="release_migration_executed",
            entity_id=mig_id, entity_type="module_release_migration",
            detail=f"{spec} -> v{target['version']}: {reason}", config_release_id=target["id"],
            provenance={"policy": "release_migration", "migration_id": mig_id, "actor": actor_email,
                        "reason": reason, "from": spec, "to_version": target["version"], "scope": scope,
                        "summary": summary},
        )


# ── history ───────────────────────────────────────────────────────────────────

def _iso(v):
    return v.isoformat() if v is not None else None


async def svc_list_migrations(session: AsyncSession, ref: str) -> dict:
    """Executed migrations of a workspace, newest first (dry runs are never stored)."""
    ws = await _workspace(session, ref)
    rows = (await session.execute(text("""
        SELECT m.id, m.from_spec, m.scope, m.reason, m.actor, m.status, m.summary, m.created_at, m.finished_at,
               r.version AS to_version, (m.status = 'running' AND {stale}) AS stale
          FROM module_release_migrations m JOIN tenant_config_releases r ON r.id = m.to_release_id
         WHERE m.tenant_id = :tid ORDER BY m.created_at DESC LIMIT 100
    """.format(stale=_STALE_SQL)), {"tid": ws["tenant_id"], "stale": STALE_AFTER_SECONDS})).mappings().all()
    # `stale` (F5a): still 'running' but no heartbeat for STALE_AFTER_SECONDS — the process died; it is
    # marked failed on the next execute of this workspace or the next app start.
    return {"items": [{"id": str(r["id"]), "from": r["from_spec"], "to_version": r["to_version"],
                       "scope": r["scope"], "reason": r["reason"], "actor": r["actor"], "status": r["status"],
                       "stale": bool(r["stale"]), "summary": r["summary"], "created_at": _iso(r["created_at"]),
                       "finished_at": _iso(r["finished_at"])} for r in rows]}


async def svc_get_migration(session: AsyncSession, ref: str, migration_id: str) -> dict:
    """One migration with its journal items (site pins + records, incl. the pre-migration state)."""
    ws = await _workspace(session, ref)
    head = (await session.execute(text("""
        SELECT m.id, m.from_spec, m.scope, m.reason, m.actor, m.status, m.summary, m.created_at, m.finished_at,
               r.version AS to_version, (m.status = 'running' AND {stale}) AS stale
          FROM module_release_migrations m JOIN tenant_config_releases r ON r.id = m.to_release_id
         WHERE m.tenant_id = :tid AND m.id::text = :mid
    """.format(stale=_STALE_SQL)), {"tid": ws["tenant_id"], "mid": migration_id,
                                    "stale": STALE_AFTER_SECONDS})).mappings().first()
    if not head:
        raise HTTPException(status_code=404, detail="Migration not found.")
    items = (await session.execute(text("""
        SELECT i.site_id, i.record_id, i.module_key, fr.version AS from_version, i.before_stage, i.after_stage,
               i.before_state, i.plan, i.created_at
          FROM module_release_migration_items i
          JOIN tenant_config_releases fr ON fr.id = i.from_release_id
         WHERE i.migration_id = :mid ORDER BY i.created_at, i.record_id NULLS FIRST
    """), {"mid": head["id"]})).mappings().all()
    return {"id": str(head["id"]), "from": head["from_spec"], "to_version": head["to_version"],
            "scope": head["scope"], "reason": head["reason"], "actor": head["actor"], "status": head["status"],
            "stale": bool(head["stale"]), "summary": head["summary"], "created_at": _iso(head["created_at"]),
            "finished_at": _iso(head["finished_at"]),
            "items": [{"site_id": str(i["site_id"]), "record_id": str(i["record_id"]) if i["record_id"] else None,
                       "module_key": i["module_key"], "from_version": i["from_version"],
                       "before_stage": i["before_stage"], "after_stage": i["after_stage"],
                       "before_state": i["before_state"], "plan": i["plan"], "at": _iso(i["created_at"])}
                      for i in items]}
