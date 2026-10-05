#!/usr/bin/env python3
"""Cross-check: drive F3's reference interpreter (third_party/matrix-adapters/runtime.py, used read-only)
end-to-end and persist EVERYTHING it produces into F2's proposed tables on the throwaway DB.

  python3 f3_runtime_fit.py DB STATE.json SEED_JSON

Flow (tenant T1 from validate_proposal.py, whose live release is v2 of the Starbucks seed + the custom
`vendor_onboarding` module):
  1. a new site is created with the app's columns only -> auto-pinned to the live release;
  2. gate facts come from F2's view `site_module_outcomes.reached` (cumulative) — the entry gate
     (bd reached 'done') is closed, then opens after the site's BD status reaches loi_uploaded;
  3. executive submits stage 1, supervisor approves, supervisor submits stage 2, business admin approves;
  4. a second site runs with a business-admin OVERRIDE on the executive step;
  5. every event -> audit_logs (config_release_id, module_key, provenance{seq,prev,hash,override});
     every approval event -> module_approvals (runtime.approval_row + is_override = event.override);
     state -> module_records (runtime.module_record_row + runtime_state); stage rows upserted;
  6. the hash chain is re-verified from what the DB stored (runtime.verify_chain).
Exit 1 on any refusal by the DB.
"""
import asyncio
import json
import os
import sys
import uuid

import asyncpg

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTERS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "third_party", "matrix-adapters"))
sys.path.insert(0, ADAPTERS)
sys.path.insert(0, HERE)
import runtime as rt_mod  # noqa: E402  (F3, read-only)
from validate_proposal import build_manifests, connect  # noqa: E402

POSITIVE = ["yes", "done", "approved", "positive", "ready", "received", "active"]  # same as F3's test helper


def fill(form):
    out = {}
    for k, s in form["schema"]["properties"].items():
        if "enum" in s:
            out[k] = next((e for e in s["enum"] if e in POSITIVE), s["enum"][0])
        elif s.get("type") == "boolean":
            out[k] = True
        elif s.get("type") == "number":
            out[k] = s.get("minimum", 1)
        elif s.get("format") == "date":
            out[k] = "2026-10-04"
        elif s.get("format") == "data-url":
            out[k] = "data:application/pdf;base64,JVBERi0xLjQK"
        elif "pattern" in s:
            out[k] = "27AAPFU0939F1ZV" if "A-Z" in s["pattern"] else "https://example.com/x"
        else:
            out[k] = "sample"
    return out


async def facts_for(conn, site):
    rows = await conn.fetch("SELECT module_key, reached FROM site_module_outcomes WHERE site_id=$1", site)
    return {"reached": {r["module_key"]: list(r["reached"]) for r in rows}, "stages": {}, "fields": {}}


async def persist(conn, tenant, site, rid, release, module_key, state, events, exit_signal):
    for ev in events:
        await conn.execute(
            "INSERT INTO audit_logs (tenant_id, site_id, actor_id, actor_name, action, config_release_id, module_key, provenance) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
            tenant, site, None if ev["actor"] == "system" else uuid.UUID(ev["actor"]), ev["actor_role"],
            f"module_{ev['type']}", release, module_key, json.dumps(ev))
        row = rt_mod.approval_row(ev)
        if row:
            await conn.execute(
                "INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name, status) VALUES ($1,$2,$3,NULL,'in progress') "
                "ON CONFLICT (record_id, stage_order) DO NOTHING", rid, row["stage_order"], tenant)
            await conn.execute(
                "INSERT INTO module_approvals (tenant_id, record_id, stage_order, tier, actor_id, actor_role, acting_as_delegate, "
                "verdict, comment, is_override) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                tenant, rid, row["stage_order"], row["tier"], uuid.UUID(row["actor_id"]), row["actor_role"],
                row["acting_as_delegate"], row["verdict"], row["comment"], bool(ev["override"]))
    cols = rt_mod.module_record_row(state, exit_signal)
    await conn.execute(
        "UPDATE module_records SET status=$2, current_stage=$3, exit_outcome=$4, "
        "closed_at = CASE WHEN $4::text IS NULL THEN NULL ELSE coalesce(closed_at, now()) END, runtime_state=$5::jsonb WHERE id=$1",
        rid, cols["status"], cols["current_stage"], cols["exit_outcome"], json.dumps(state))


async def run_case(conn, ids, release, module, label, steps, open_gate=True):
    tenant = uuid.UUID(ids["tenant"])
    site = await conn.fetchval("INSERT INTO sites (tenant_id, name, city, submitted_by, status) VALUES ($1,$2,'Pune',$3,'draft_submitted') RETURNING id",
                               tenant, label, uuid.UUID(ids["exe"]))
    pin = await conn.fetchval("SELECT config_release_id FROM sites WHERE id=$1", site)
    assert pin == release, f"site not pinned to live release ({pin} != {release})"
    rid = await conn.fetchval("INSERT INTO module_records (tenant_id, site_id, module_key) VALUES ($1,$2,$3) RETURNING id",
                              tenant, site, module["key"])
    rt = rt_mod.ModuleRuntime(module, str(release))
    facts = await facts_for(conn, site)
    state, events = rt.new_case(str(rid), str(site), facts)
    print(f"[{label}] gate with bd reached={facts['reached'].get('bd')}: status={state['status']}")
    if open_gate:
        await conn.execute("UPDATE sites SET status='loi_uploaded', loi_uploaded_at=now() WHERE id=$1", site)
        facts = await facts_for(conn, site)
        state, more = rt.refresh(state, facts)
        events += more
        print(f"[{label}] gate with bd reached={facts['reached'].get('bd')}: status={state['status']}")
    for actor_key, role, action in steps:
        actor = rt_mod.Actor(ids[actor_key], role, delegated_sites=(str(site),))
        nxt = rt.next_step(state)
        payload = {"values": fill(nxt["form"])} if action == "submit" and nxt.get("form") else {}
        state, more = rt.act(state, actor, action, payload, facts)
        events += more
        print(f"[{label}] {role} {action} -> " + ", ".join(f"{e['type']}{'(override)' if e['override'] else ''}" for e in more))
    await persist(conn, tenant, site, rid, release, module["key"], state, events, module.get("exit_signal"))
    stored = await conn.fetch("SELECT provenance FROM audit_logs WHERE site_id=$1 AND module_key=$2 ORDER BY (provenance->>'seq')::int",
                              site, module["key"])
    chain_ok = rt_mod.verify_chain([json.loads(r["provenance"]) for r in stored])
    out = await conn.fetchrow("SELECT outcome, reached FROM site_module_outcomes WHERE site_id=$1 AND module_key=$2", site, module["key"])
    n_appr = await conn.fetchval("SELECT count(*) FROM module_approvals WHERE record_id=$1", rid)
    n_over = await conn.fetchval("SELECT count(*) FROM module_approvals WHERE record_id=$1 AND is_override", rid)
    print(f"[{label}] persisted: {len(events)} audit events (hash chain verified from DB: {chain_ok}), "
          f"{n_appr} approvals ({n_over} override), view outcome={out['outcome']} reached={list(out['reached'])}")
    return chain_ok


async def main(db, state_path, seed_path):
    ids = json.load(open(state_path))
    conn = await connect(db)
    try:
        tenant = uuid.UUID(ids["tenant"])
        release = await conn.fetchval("SELECT release_id FROM tenant_config_live WHERE tenant_id=$1", tenant)
        manifest = json.loads(await conn.fetchval("SELECT manifest FROM tenant_config_releases WHERE id=$1", release))
        module = next(m for m in manifest["modules"] if m["key"] == "vendor_onboarding")
        _ = build_manifests  # same fixture family as validate_proposal.py
        ok1 = await run_case(conn, ids, release, module, "F3 runtime, normal chain",
                             [("exe", "executive", "submit"), ("sup", "supervisor", "approve"),
                              ("sup", "supervisor", "submit"), ("ba", "business_admin", "approve")])
        ok2 = await run_case(conn, ids, release, module, "F3 runtime, admin override",
                             [("ba", "business_admin", "submit"), ("sup", "supervisor", "approve"),
                              ("sup", "supervisor", "submit"), ("ba", "business_admin", "approve")])
        print("RESULT:", "PASS" if ok1 and ok2 else "FAIL")
        return 0 if ok1 and ok2 else 1
    except asyncpg.PostgresError as exc:
        print(f"RESULT: FAIL — DB refused: {exc.sqlstate} {exc}")
        return 1
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3])))
