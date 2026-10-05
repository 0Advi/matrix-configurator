#!/usr/bin/env python3
"""Behavioural validation of the proposed change set (throwaway DB only).

  python3 validate_proposal.py before DB STATE.json   # on the real-schema model, BEFORE the proposals
  python3 validate_proposal.py after  DB STATE.json MANIFEST_SEED.json   # AFTER the proposals
  python3 validate_proposal.py vocab  DB             # module acceptance matrix only (any DB)

`before`: provisions a tenant exactly the way the app does (tenancy_service SQL), adds users and a
site, prints the module-acceptance matrix of the five module-bearing tables, and PERSISTS one
representative row per accepted (table, module) — the "existing-style data" the proposals must keep
accepting. `after`: re-checks that data, re-runs the matrix, and exercises releases, pinning, the
generic runtime, RLS and cascades. Every probe runs in a transaction that is rolled back unless it
is an explicit setup step. Exit code 1 if any expectation fails.
"""
import asyncio
import copy
import json
import os
import secrets
import sys
import uuid

import asyncpg

PORT = int(os.environ.get("AUDIT_PGPORT", "54339"))
RESULTS = []

KEYS = ["bd", "legal", "design", "project", "nso", "project_excellence", "financial_closure",
        "quality_audit", "payment", "finance_ca", "launch_approval",
        "vendor_onboarding", "store_design",
        "pex", "Vendor", "x", "admin", "9lives", "a-b", "vendor onboarding", ""]
TABLES = ["module_codes", "supervisor_invite_codes", "user_module_memberships",
          "site_delegations", "supervisor_executive_requests"]


async def connect(db):
    pw = open(os.environ["AUDIT_PGPASS_FILE"]).read().strip()
    return await asyncpg.connect(host="127.0.0.1", port=PORT, user="postgres", password=pw, database=db)


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}")


async def attempt(conn, sql, *args, setup=None):
    """Run sql in a transaction that is ALWAYS rolled back. Returns (ok, rows|error)."""
    tr = conn.transaction()
    await tr.start()
    try:
        if setup:
            for s in setup:
                await conn.execute(s)
        rows = await conn.fetch(sql, *args)
        return True, rows
    except asyncpg.PostgresError as exc:
        return False, f"{exc.sqlstate} {type(exc).__name__}: {str(exc).splitlines()[0][:200]}"
    finally:
        await tr.rollback()


def expect(name, res, should_succeed, note=""):
    ok, payload = res
    good = ok == should_succeed
    detail = ("accepted" if ok else f"rejected ({payload})") + (f" — {note}" if note else "")
    record(name, good, detail)
    return ok


async def provision_tenant(conn, label):
    """tenancy_service._create_tenant_with_retry + approve_workspace_request, same SQL."""
    slug = f"audit-{label}-{secrets.token_hex(2)}"
    code = f"AUD{label.upper()[:3]}-{secrets.token_hex(2).upper()}"
    t = await conn.fetchrow(
        "INSERT INTO tenants (slug, name, plan, seat_limit, workspace_code) "
        "VALUES ($1, $2, 'standard', 10, $3) RETURNING id, workspace_code, seat_limit",
        slug, f"Audit {label}", code)
    tid = t["id"]
    ba = uuid.uuid4()
    await conn.execute(
        "INSERT INTO users (id, tenant_id, role, email, name, is_active) "
        "VALUES ($1, $2, 'business_admin', $3, $4, true)", ba, tid, f"ba-{label}@audit.test", f"BA {label}")
    await conn.execute("INSERT INTO business_admins (user_id, tenant_id, promoted_at) VALUES ($1, $2, now())", ba, tid)
    sup = uuid.uuid4()
    exe = uuid.uuid4()
    await conn.execute("INSERT INTO users (id, tenant_id, role, email, name, is_active) VALUES ($1,$2,'supervisor',$3,'Sup',true)",
                       sup, tid, f"sup-{label}@audit.test")
    await conn.execute("INSERT INTO users (id, tenant_id, role, email, name, is_active) VALUES ($1,$2,'executive',$3,'Exe',true)",
                       exe, tid, f"exe-{label}@audit.test")
    return {"tenant": str(tid), "ba": str(ba), "sup": str(sup), "exe": str(exe)}


async def new_site(conn, ids, name):
    # Columns the ORM always sends for a draft (bd_service create path); the rest are defaults.
    return str(await conn.fetchval(
        "INSERT INTO sites (tenant_id, name, city, submitted_by, status) "
        "VALUES ($1, $2, 'Mumbai', $3, 'draft_submitted') RETURNING id",
        uuid.UUID(ids["tenant"]), name, uuid.UUID(ids["exe"])))


def insert_sql(table):
    return {
        "module_codes": ("INSERT INTO module_codes (tenant_id, module, code, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1",
                         lambda ids, k: (uuid.UUID(ids["tenant"]), k, "MC-" + secrets.token_hex(5), uuid.UUID(ids["ba"]))),
        "supervisor_invite_codes": ("INSERT INTO supervisor_invite_codes (tenant_id, supervisor_id, module, code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1",
                                    lambda ids, k: (uuid.UUID(ids["tenant"]), uuid.UUID(ids["sup"]), k, "SC-" + secrets.token_hex(5))),
        "user_module_memberships": ("INSERT INTO user_module_memberships (user_id, tenant_id, module, role_in_module, supervisor_id) "
                                    "VALUES ($1,$2,$3,'executive',$4) ON CONFLICT DO NOTHING RETURNING 1",
                                    lambda ids, k: (uuid.UUID(ids["exe"]), uuid.UUID(ids["tenant"]), k, uuid.UUID(ids["sup"]))),
        "site_delegations": ("INSERT INTO site_delegations (tenant_id, site_id, module, delegate_user_id, granted_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1",
                             lambda ids, k: (uuid.UUID(ids["tenant"]), uuid.UUID(ids["site"]), k, uuid.UUID(ids["exe"]), uuid.UUID(ids["sup"]))),
        "supervisor_executive_requests": ("INSERT INTO supervisor_executive_requests (tenant_id, supervisor_id, module) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
                                          lambda ids, k: (uuid.UUID(ids["tenant"]), uuid.UUID(ids["sup"]), k)),
    }[table]


async def matrix(conn, ids, title):
    print(f"\n#### Module acceptance matrix — {title}\n")
    print("| key | " + " | ".join(TABLES) + " |")
    print("|---|" + "---|" * len(TABLES))
    out = {}
    for k in KEYS:
        cells = []
        for t in TABLES:
            sql, args = insert_sql(t)
            ok, payload = await attempt(conn, sql, *args(ids, k))
            out[(t, k)] = ok
            cells.append("✅" if ok else "❌ " + (payload.split(" ")[0] if isinstance(payload, str) else ""))
        print(f"| `{k or '(empty)'}` | " + " | ".join(cells) + " |")
    print()
    return out


async def cmd_vocab(db):
    conn = await connect(db)
    try:
        tr = conn.transaction(); await tr.start()
        ids = await provision_tenant(conn, "vocab")
        ids["site"] = await new_site(conn, ids, "vocab site")
        await matrix(conn, ids, db)
        # the two prior findings
        for status in ("launched", "legal_review", "pushed_to_payments"):
            ok, p = await attempt(conn, "UPDATE sites SET status=$1 WHERE id=$2 RETURNING 1", status, uuid.UUID(ids["site"]))
            print(f"sites.status='{status}': {'accepted' if ok else 'rejected ' + p}")
        await tr.rollback()
    finally:
        await conn.close()


async def cmd_before(db, state_path):
    conn = await connect(db)
    try:
        ids = await provision_tenant(conn, "t1")
        ids["site"] = await new_site(conn, ids, "legacy site S0")
        m = await matrix(conn, ids, f"{db} BEFORE proposals")
        persisted = []
        for (t, k), ok in m.items():
            if ok:
                sql, args = insert_sql(t)
                a = list(args(ids, k))
                if t == "user_module_memberships":
                    # one executive row per (module) is fine; supervisors differ per module not needed
                    pass
                await conn.execute(sql.replace(" RETURNING 1", ""), *a)
                persisted.append([t, k])
        ids["persisted"] = persisted
        for k in ("vendor_onboarding",):
            for t in TABLES:
                sql, args = insert_sql(t)
                expect(f"before: custom key '{k}' in {t}", await attempt(conn, sql, *args(ids, k)), False,
                       "custom modules are blocked today")
        json.dump(ids, open(state_path, "w"), indent=1)
        print(f"persisted {len(persisted)} representative existing-style rows for tenant {ids['tenant']}")
    finally:
        await conn.close()


def build_manifests(seed_path):
    seed = json.load(open(seed_path))["workspaces"]["starbucks"]["manifest"]
    v1 = copy.deepcopy(seed)
    v1["workspace"]["live_version"] = "v1"
    vendor = {
        "key": "vendor_onboarding", "name": "Vendor onboarding", "type": "custom", "enabled": True,
        "route": "/m/vendor_onboarding", "state": "live",
        "tiers": {"supervisor": True, "executive": True, "business_admin_signoff": True, "delegation": True},
        "entry_gate": {"match": "all", "conditions": [{"source": "bd", "outcome": "done"}],
                       "refusal_message": "Vendor onboarding opens once the LOI is signed."},
        "stages": [
            {"order": 1, "name": "Vendor KYC", "outcome": "submitted", "terminal": False, "approvers": ["executive", "supervisor"],
             "fields": [{"key": "gstin", "label": "GSTIN", "kind": "text", "required": True, "validation": None, "affects_outcome": False},
                        {"key": "kyc_ok", "label": "KYC ok", "kind": "yesno", "required": True, "validation": None, "affects_outcome": True}]},
            {"order": 2, "name": "Commercial sign-off", "outcome": "approved", "terminal": True, "approvers": ["business_admin"],
             "fields": [{"key": "term_sheet", "label": "Signed term sheet", "kind": "file", "required": True, "validation": "pdf", "affects_outcome": False}]},
        ],
        "rollup": {"strategy": "all_positive"}, "exit_signal": "approved", "navigation": [],
    }
    v1["modules"].append(vendor)
    v2 = copy.deepcopy(v1)
    v2["workspace"]["live_version"] = "v2"
    v2["modules"][-1]["stages"][1]["name"] = "Commercial sign-off (v2)"
    v2["modules"][-1]["stages"][1]["approvers"] = ["supervisor", "business_admin"]
    return v1, v2


async def cmd_after(db, state_path, seed_path):
    ids = json.load(open(state_path))
    conn = await connect(db)
    T1 = uuid.UUID(ids["tenant"])
    try:
        # (b) existing-style data still valid: every new constraint is VALIDATED (= checked all rows)
        rows = await conn.fetch(
            "SELECT conrelid::regclass::text AS t, conname, convalidated FROM pg_constraint "
            "WHERE conname ~ '^(chk|fk)_(module_codes|supervisor_invite_codes|user_module_memberships|site_delegations|supervisor_executive_requests)_(module_key|tenant_module)$' "
            "ORDER BY 1,2")
        record("after: 10 new module constraints present (5 key-shape CHECK + 5 registry FK)", len(rows) == 10, f"{len(rows)} found")
        record("after: all 10 VALIDATED over existing rows", all(r["convalidated"] for r in rows),
               ", ".join(f"{r['conname']}={r['convalidated']}" for r in rows if not r["convalidated"]) or "all convalidated=true")
        left = await conn.fetch(
            "SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid) d FROM pg_constraint con "
            "JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum = ANY(con.conkey) "
            "WHERE rel.relname = ANY($1::text[]) AND con.contype='c' AND a.attname='module' AND con.conname !~ '_module_key$'", TABLES)
        record("after: no hard-coded module IN-list CHECK left", len(left) == 0, "; ".join(f"{r['relname']}.{r['conname']}" for r in left) or "none")
        n = 0
        for t, k in ids["persisted"]:
            n += await conn.fetchval(f"SELECT count(*) FROM {t} WHERE tenant_id=$1 AND module=$2", T1, k)
        record("after: persisted existing-style rows survive", n >= len(ids["persisted"]), f"{n} rows for {len(ids['persisted'])} (table,key) pairs")

        # module registry backfill for the pre-existing tenant
        tm = await conn.fetch("SELECT module_key, kind, enabled FROM tenant_modules WHERE tenant_id=$1 ORDER BY position", T1)
        record("after: backfill registered built-ins for pre-existing tenant", len(tm) >= 10,
               ", ".join(f"{r['module_key']}{'' if r['enabled'] else '(off)'}" for r in tm))

        # app provisioning path still works and seeds the registry through the trigger
        ids2 = await provision_tenant(conn, "t2")
        T2 = uuid.UUID(ids2["tenant"])
        c2 = await conn.fetchval("SELECT count(*) FROM tenant_modules WHERE tenant_id=$1", T2)
        record("after: app's INSERT INTO tenants seeds tenant_modules (trigger)", c2 == 10, f"{c2} rows")
        expect("after: app SQL business_admin_service mint dept code ('legal') for new tenant",
               await attempt(conn, "INSERT INTO module_codes (tenant_id, module, code, created_by) VALUES ($1,'legal',$2,$3) "
                                   "ON CONFLICT (tenant_id, module) DO UPDATE SET code = EXCLUDED.code, rotated_at = now(), "
                                   "created_by = EXCLUDED.created_by RETURNING module, code", T2, "LG-" + secrets.token_hex(4), uuid.UUID(ids2["ba"])), True)
        ids2["site"] = await new_site(conn, ids2, "t2 site")

        await matrix(conn, ids, f"{db} AFTER proposals, tenant T1 (vendor_onboarding NOT yet registered)")

        # releases: publish v1 (Starbucks seed manifest + a custom vendor_onboarding module)
        v1, v2 = build_manifests(seed_path)
        rel1 = await conn.fetchval(
            "INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by, reason, source_ref) "
            "VALUES ($1, 1, $2::jsonb, 'platform_admin', 'audit v1', 'cfg_workspaces:starbucks') RETURNING id", T1, json.dumps(v1))
        sha = await conn.fetchval("SELECT manifest_sha256 FROM tenant_config_releases WHERE id=$1", rel1)
        record("after: release v1 stored, sha256 filled by trigger", bool(sha) and len(sha) == 64, sha[:16] + "…")
        npos = await conn.fetchval("SELECT public.cfg_activate_release($1, 'platform_admin')", rel1)
        tmr = {r["module_key"]: r for r in await conn.fetch("SELECT * FROM tenant_modules WHERE tenant_id=$1", T1)}
        record("after: cfg_activate_release projected manifest", npos == len(v1["modules"]),
               f"{npos} modules; design.enabled={tmr['design']['enabled']} project_excellence.enabled={tmr['project_excellence']['enabled']} "
               f"(Starbucks switches both off); custom: {sorted(k for k, r in tmr.items() if r['kind'] == 'custom')}; "
               f"nso.supervisor_only={tmr['nso']['supervisor_only']}")
        expect("after: release UPDATE refused (append-only)",
               await attempt(conn, "UPDATE tenant_config_releases SET reason='x' WHERE id=$1 RETURNING 1", rel1), False)
        expect("after: release DELETE refused (append-only)",
               await attempt(conn, "DELETE FROM tenant_config_releases WHERE id=$1 RETURNING 1", rel1), False)
        expect("after: duplicate version refused", await attempt(
            conn, "INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by) VALUES ($1,1,$2::jsonb,'x') RETURNING 1",
            T1, json.dumps(v1)), False)
        expect("after: manifest without modules[] refused", await attempt(
            conn, "INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by) VALUES ($1,9,'{}'::jsonb,'x') RETURNING 1",
            T1), False)

        m_after = await matrix(conn, ids, f"{db} AFTER proposals, tenant T1 with release v1 live (vendor_onboarding registered)")
        for t in TABLES:
            record(f"after: custom key vendor_onboarding accepted in {t} (T1)", m_after[(t, "vendor_onboarding")])
            record(f"after: custom key store_design (Starbucks seed) accepted in {t} (T1)", m_after[(t, "store_design")])
            for junk in ("Vendor", "x", "admin", "9lives", "a-b", "vendor onboarding", "", "pex"):
                record(f"after: junk/alias key '{junk}' rejected in {t}", not m_after[(t, junk)])
            for b in ("bd", "legal", "design", "project", "nso", "project_excellence"):
                record(f"after: built-in '{b}' still accepted in {t}", m_after[(t, b)])
        for t in TABLES:
            sql, args = insert_sql(t)
            expect(f"after: T1's custom key refused for tenant T2 in {t}", await attempt(conn, sql, *args(ids2, "vendor_onboarding")), False)
        expect("after: custom module may not reuse a built-in key/alias ('pex')",
               await attempt(conn, "INSERT INTO tenant_modules (tenant_id, module_key, kind, label) VALUES ($1,'pex','custom','x') RETURNING 1", T2), False)

        # pinning
        S0 = uuid.UUID(ids["site"])
        pin0 = await conn.fetchval("SELECT config_release_id FROM sites WHERE id=$1", S0)
        record("after: legacy site keeps NULL pin (hard-coded flow)", pin0 is None, str(pin0))
        S1 = uuid.UUID(await new_site(conn, ids, "S1 under v1"))
        pin1 = await conn.fetchval("SELECT config_release_id FROM sites WHERE id=$1", S1)
        record("after: new site auto-pinned to live release (no app change)", pin1 == rel1, str(pin1))
        rel2 = await conn.fetchval(
            "INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by) VALUES ($1, 2, $2::jsonb, 'platform_admin') RETURNING id",
            T1, json.dumps(v2))
        await conn.fetchval("SELECT public.cfg_activate_release($1, 'platform_admin')", rel2)
        S2 = uuid.UUID(await new_site(conn, ids, "S2 under v2"))
        pin1b = await conn.fetchval("SELECT config_release_id FROM sites WHERE id=$1", S1)
        pin2 = await conn.fetchval("SELECT config_release_id FROM sites WHERE id=$1", S2)
        record("after: publishing v2 leaves in-flight S1 on v1; new S2 on v2", pin1b == rel1 and pin2 == rel2, f"S1={pin1b} S2={pin2}")
        expect("after: re-pin S1 to v2 refused", await attempt(conn, "UPDATE sites SET config_release_id=$1 WHERE id=$2 RETURNING 1", rel2, S1), False)
        expect("after: re-pin S1 allowed only with matrix.allow_repin=on",
               await attempt(conn, "UPDATE sites SET config_release_id=$1 WHERE id=$2 RETURNING 1", rel2, S1,
                             setup=["SET LOCAL matrix.allow_repin = 'on'"]), True)
        expect("after: pin to another tenant's release refused",
               await attempt(conn, "UPDATE sites SET config_release_id=$1 WHERE id=$2 RETURNING 1", rel1, uuid.UUID(ids2["site"])), False)
        expect("after: ordinary site UPDATE (ORM-style, status) unaffected by pin trigger",
               await attempt(conn, "UPDATE sites SET status='shortlisted', shortlisted_at=now() WHERE id=$1 RETURNING 1", S1), True)

        # generic runtime
        r1 = await conn.fetchval("INSERT INTO module_records (tenant_id, site_id, module_key, status, current_stage) "
                                 "VALUES ($1,$2,'vendor_onboarding','in progress',1) RETURNING id", T1, S1)
        rr = await conn.fetchval("SELECT release_id FROM module_records WHERE id=$1", r1)
        record("after: module record for custom module inherits the site's pin (v1)", rr == rel1, str(rr))
        expect("after: module record on S1 with release v2 refused (site pinned to v1)",
               await attempt(conn, "INSERT INTO module_records (tenant_id, site_id, module_key, release_id) VALUES ($1,$2,'store_design',$3) RETURNING 1",
                             T1, S1, rel2), False)
        expect("after: module record for unregistered module refused",
               await attempt(conn, "INSERT INTO module_records (tenant_id, site_id, module_key) VALUES ($1,$2,'ghost_module') RETURNING 1", T1, S1), False)
        expect("after: module record across tenants refused",
               await attempt(conn, "INSERT INTO module_records (tenant_id, site_id, module_key) VALUES ($1,$2,'bd') RETURNING 1", T2, S1), False)
        await conn.execute("INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name, status, field_values) "
                           "VALUES ($1, 1, $2, NULL, 'in progress', '{\"gstin\":\"27ABCDE1234F1Z5\",\"kyc_ok\":\"yes\"}')", r1, T1)
        sname = await conn.fetchval("SELECT stage_name FROM module_stage_states WHERE record_id=$1 AND stage_order=1", r1)
        record("after: stage row validated against pinned manifest; name filled", sname == "Vendor KYC", sname)
        await conn.execute("INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name) VALUES ($1, 2, $2, NULL)", r1, T1)
        expect("after: stage 9 (absent from manifest) refused",
               await attempt(conn, "INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name) VALUES ($1,9,$2,'x') RETURNING 1", r1, T1), False)
        expect("after: field_values must be a JSON object",
               await attempt(conn, "INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name, field_values) VALUES ($1,1,$2,'x','[1]') "
                                   "ON CONFLICT (record_id, stage_order) DO UPDATE SET field_values = EXCLUDED.field_values RETURNING 1", r1, T1), False)
        EXE, SUP, BA = uuid.UUID(ids["exe"]), uuid.UUID(ids["sup"]), uuid.UUID(ids["ba"])
        ins = ("INSERT INTO module_approvals (tenant_id, record_id, stage_order, tier, actor_id, actor_role, verdict, comment, is_override) "
               "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id")
        expect("after: executive submits stage 1 (first tier of chain [executive, supervisor])",
               await attempt(conn, ins, T1, r1, 1, "executive", EXE, "executive", "submitted", None, False), True)
        expect("after: supervisor does the executive step of stage 1 (higher tier in the chain, no override)",
               await attempt(conn, ins, T1, r1, 1, "executive", SUP, "supervisor", "submitted", None, False), True)
        expect("after: 'submitted' by a non-first tier refused",
               await attempt(conn, ins, T1, r1, 1, "supervisor", SUP, "supervisor", "submitted", None, False), False)
        a_ok = await conn.fetchval(ins, T1, r1, 1, "supervisor", SUP, "supervisor", "approved", "KYC fine", False)
        record("after: supervisor approves stage 1 (approver per v1)", a_ok is not None, str(a_ok))
        expect("after: business_admin on stage 1 WITHOUT override flag refused (not in chain)",
               await attempt(conn, ins, T1, r1, 1, "supervisor", BA, "business_admin", "approved", None, False), False)
        expect("after: business_admin on stage 1 as a FLAGGED override accepted (production guard bypass, recorded)",
               await attempt(conn, ins, T1, r1, 1, "supervisor", BA, "business_admin", "approved", "admin override", True), True)
        expect("after: business_admin override submitting the executive step accepted (flagged)",
               await attempt(conn, ins, T1, r1, 1, "executive", BA, "business_admin", "submitted", None, True), True)
        expect("after: override flag on a non-admin actor refused",
               await attempt(conn, ins, T1, r1, 1, "executive", SUP, "supervisor", "approved", None, True), False)
        expect("after: tier outside the stage chain refused even as override",
               await attempt(conn, ins, T1, r1, 1, "business_admin", BA, "business_admin", "approved", None, True), False)
        expect("after: supervisor approving stage 2 on S1 refused (v1 chain [business_admin])",
               await attempt(conn, ins, T1, r1, 2, "supervisor", SUP, "supervisor", "approved", None, False), False)
        expect("after: business_admin tier with a supervisor actor refused",
               await attempt(conn, ins, T1, r1, 2, "business_admin", SUP, "supervisor", "approved", None, False), False)
        expect("after: admin-only stage WITH fields: business_admin 'submitted' on stage 2 accepted (form = sign-off)",
               await attempt(conn, ins, T1, r1, 2, "business_admin", BA, "business_admin", "submitted", None, False), True)
        expect("after: override flag on an entitled actor refused (flag must be truthful)",
               await attempt(conn, ins, T1, r1, 2, "business_admin", BA, "business_admin", "approved", None, True), False)
        expect("after: business_admin approves stage 2 on S1", await attempt(conn, ins, T1, r1, 2, "business_admin", BA, "business_admin", "approved", None, False), True)
        r2 = await conn.fetchval("INSERT INTO module_records (tenant_id, site_id, module_key) VALUES ($1,$2,'vendor_onboarding') RETURNING id", T1, S2)
        await conn.execute("INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name) VALUES ($1, 2, $2, NULL)", r2, T1)
        expect("after: supervisor approving stage 2 on S2 accepted (v2 chain [supervisor, business_admin])",
               await attempt(conn, ins, T1, r2, 2, "supervisor", SUP, "supervisor", "approved", None, False), True)
        expect("after: approval UPDATE refused (append-only)",
               await attempt(conn, "UPDATE module_approvals SET verdict='rejected' WHERE id=$1 RETURNING 1", a_ok), False)
        expect("after: approval DELETE refused (append-only)",
               await attempt(conn, "DELETE FROM module_approvals WHERE id=$1 RETURNING 1", a_ok), False)

        # runtime_state (F3 interpreter state) persisted with the record
        state_ok = json.dumps({"release": str(rel1), "step": 0, "stage": 2, "pass": [], "verdicts": [],
                               "reached": ["submitted", "approved"], "seq": 7, "last_hash": "ab" * 32})
        expect("after: runtime_state for the pinned release stored",
               await attempt(conn, "UPDATE module_records SET runtime_state=$1::jsonb WHERE id=$2 RETURNING 1", state_ok, r1), True)
        expect("after: runtime_state of another release refused",
               await attempt(conn, "UPDATE module_records SET runtime_state=$1::jsonb WHERE id=$2 RETURNING 1",
                             json.dumps({"release": str(rel2)}), r1), False)
        expect("after: runtime_state must be an object",
               await attempt(conn, "UPDATE module_records SET runtime_state='[]'::jsonb WHERE id=$1 RETURNING 1", r1), False)
        await conn.execute("UPDATE module_records SET status='approved', exit_outcome='approved', closed_at=now(), current_stage=2, "
                           "runtime_state=$2::jsonb WHERE id=$1", r1, state_ok)
        expect("after: exit_outcome without closed_at refused",
               await attempt(conn, "UPDATE module_records SET closed_at=NULL WHERE id=$1 RETURNING 1", r1), False)
        expect("after: outcome outside configurator vocabulary refused",
               await attempt(conn, "UPDATE module_records SET status='launched' WHERE id=$1 RETURNING 1", r1), False)
        outs = await conn.fetch("SELECT module_key, raw_status, outcome, reached, source FROM site_module_outcomes WHERE site_id=$1 ORDER BY module_key", S1)
        got = {r["module_key"]: r for r in outs}
        record("after: gate-input view merges built-in mirrors and custom outcomes (custom reached from runtime_state)",
               "vendor_onboarding" in got and got["vendor_onboarding"]["outcome"] == "approved"
               and list(got["vendor_onboarding"]["reached"]) == ["submitted", "approved"] and "legal" in got and "bd" in got,
               "; ".join(f"{r['module_key']}={r['raw_status']}->{r['outcome']} reached={list(r['reached'])} [{r['source']}]" for r in outs))
        ok, rows = await attempt(conn, "SELECT module_key, reached FROM site_module_outcomes WHERE site_id=$1 AND module_key IN ('design','legal','bd') ORDER BY 1", S1,
                                 setup=[f"UPDATE sites SET design_status='approved', legal_dd_status='positive', licensing_status='complete', status='loi_uploaded' WHERE id='{S1}'"])
        cum = {r["module_key"]: sorted(r["reached"]) for r in rows} if ok else rows
        record("after: built-in reached is CUMULATIVE (design approved => allocated,in progress,submitted,approved; legal positive+licensing complete => +done)",
               ok and cum["design"] == ["allocated", "approved", "in progress", "submitted"]
               and cum["legal"] == ["approved", "done", "in progress"] and cum["bd"] == ["approved", "done", "in progress", "submitted"], str(cum))

        # production's admin-only stages WITH fields, on the real flow (matrix-bd-flow.json as a release)
        flow = json.load(open(os.path.join(os.path.dirname(seed_path), "..", "from-matrix-bd", "matrix-bd-flow.json")))
        prod = {"workspace": {"id": "audit-prod", "name": "Prod flow", "slug": "audit-prod", "live_version": "v1", "draft_version": "v1"},
                "pipeline": {"editable": False, "stages": [], "note": ""}, "signals": [],
                "modules": [{k: v for k, v in m.items() if k != "x-matrix"} for m in flow["modules"]], "permissions": []}
        relp = await conn.fetchval("INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by, source) "
                                   "VALUES ($1, 1, $2::jsonb, 'platform_admin', 'baseline') RETURNING id", T2, json.dumps(prod))
        await conn.fetchval("SELECT public.cfg_activate_release($1, 'platform_admin')", relp)
        SP = uuid.UUID(await new_site(conn, ids2, "T2 site under production-flow release"))
        BA2, SUP2 = uuid.UUID(ids2["ba"]), uuid.UUID(ids2["sup"])
        for mkey, stage, label in (("project_excellence", 3, "PEx Admin review"), ("design", 4, "Design GFC approval"),
                                   ("launch_approval", 1, "Launch Admin review")):
            rid = await conn.fetchval("INSERT INTO module_records (tenant_id, site_id, module_key) VALUES ($1,$2,$3) RETURNING id", T2, SP, mkey)
            await conn.execute("INSERT INTO module_stage_states (record_id, stage_order, tenant_id, stage_name) VALUES ($1,$2,$3,NULL)", rid, stage, T2)
            expect(f"after: built-in admin-only stage with fields representable — {label}: business_admin 'submitted'",
                   await attempt(conn, ins, T2, rid, stage, "business_admin", BA2, "business_admin", "submitted", None, False), True)
            expect(f"after: {label}: supervisor may not submit it (not in chain, no override)",
                   await attempt(conn, ins, T2, rid, stage, "business_admin", SUP2, "supervisor", "submitted", None, False), False)

        # audit provenance
        expect("after: audit_logs accepts release + provenance",
               await attempt(conn, "INSERT INTO audit_logs (tenant_id, site_id, actor_id, action, config_release_id, module_key, provenance) "
                                   "VALUES ($1,$2,$3,'module_stage_approved',$4,'vendor_onboarding','{\"policy\":\"tier\",\"rule\":\"stage1.approvers\"}') RETURNING 1",
                             T1, S1, SUP, rel1), True)
        expect("after: audit_logs legacy-style insert (no new columns) still works",
               await attempt(conn, "INSERT INTO audit_logs (tenant_id, site_id, actor_id, action, detail) VALUES ($1,$2,$3,'site_created','x') RETURNING 1",
                             T1, S1, SUP), True)
        expect("after: provenance must be an object",
               await attempt(conn, "INSERT INTO audit_logs (tenant_id, action, provenance) VALUES ($1,'x','[1]') RETURNING 1", T1), False)

        # (d) RLS on every new tenant table
        new_tables = ["tenant_config_releases", "tenant_config_live", "tenant_modules",
                      "module_records", "module_stage_states", "module_approvals"]
        pol = await conn.fetch("SELECT c.relname, c.relrowsecurity, (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' "
                               "AND p.tablename=c.relname AND p.policyname='tenant_isolation') AS n FROM pg_class c "
                               "WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY($1::text[]) ORDER BY 1",
                               new_tables + ["module_catalog"])
        for r in pol:
            want_policy = r["relname"] != "module_catalog"
            record(f"after: RLS on {r['relname']}", r["relrowsecurity"] and (r["n"] == 1) == want_policy,
                   f"rls={r['relrowsecurity']} tenant_isolation_policies={r['n']}")
        claims_t1 = json.dumps({"app_metadata": {"tenant_id": str(T1)}})
        claims_t2 = json.dumps({"app_metadata": {"tenant_id": str(T2)}})
        for t in new_tables:
            grant = f"GRANT SELECT ON public.{t} TO authenticated"
            ok1, rows1 = await attempt(conn, f"SELECT count(*) AS n, count(*) FILTER (WHERE tenant_id <> '{T1}') AS foreign_rows FROM public.{t}",
                                       setup=[grant, f"SELECT set_config('request.jwt.claims', '{claims_t1}', true)", "SET LOCAL ROLE authenticated"])
            ok0, rows0 = await attempt(conn, f"SELECT count(*) AS n FROM public.{t}",
                                       setup=[grant, "SET LOCAL ROLE authenticated"])
            total = await conn.fetchval(f"SELECT count(*) FROM public.{t}")
            record(f"after: RLS isolates {t} (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all)",
                   ok1 and rows1[0]["foreign_rows"] == 0 and ok0 and rows0[0]["n"] == 0 and total >= rows1[0]["n"],
                   f"T1-claims={rows1[0]['n'] if ok1 else rows1} no-claims={rows0[0]['n'] if ok0 else rows0} app(bypass)={total}")
        ok, err = await attempt(conn, "SELECT count(*) FROM public.module_records", setup=["SET LOCAL ROLE anon"])
        record("after: anon has no privileges on new tables (REVOKE)", not ok, err if not ok else "readable!")
        _ = claims_t2

        # cascades: a tenant with releases/registry/live pointer (no sites) can still be deleted
        ids3 = await provision_tenant(conn, "t3")
        T3 = uuid.UUID(ids3["tenant"])
        r3 = await conn.fetchval("INSERT INTO tenant_config_releases (tenant_id, version, manifest, published_by) VALUES ($1,1,$2::jsonb,'platform_admin') RETURNING id",
                                 T3, json.dumps(v1))
        await conn.fetchval("SELECT public.cfg_activate_release($1, 'platform_admin')", r3)
        expect("after: DELETE tenant (cascade into append-only tenant_config_releases, tenant_config_live, tenant_modules)",
               await attempt(conn, "DELETE FROM tenants WHERE id=$1 RETURNING 1", T3,
                             setup=[f"DELETE FROM business_admins WHERE tenant_id='{T3}'",
                                    f"DELETE FROM users WHERE tenant_id='{T3}'"]), True)
    finally:
        await conn.close()


def main():
    cmd = sys.argv[1]
    if cmd == "vocab":
        asyncio.run(cmd_vocab(sys.argv[2]))
    elif cmd == "before":
        asyncio.run(cmd_before(sys.argv[2], sys.argv[3]))
    elif cmd == "after":
        asyncio.run(cmd_after(sys.argv[2], sys.argv[3], sys.argv[4]))
    fails = [r for r in RESULTS if not r[1]]
    print(f"\nSUMMARY: {len(RESULTS) - len(fails)} pass, {len(fails)} fail")
    for f in fails:
        print(f"  FAILED: {f[0]} — {f[2]}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
