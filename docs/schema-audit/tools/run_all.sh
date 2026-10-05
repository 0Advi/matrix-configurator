#!/usr/bin/env bash
# F2 audit pipeline — reproduces every piece of evidence in docs/schema-audit/VALIDATION.md.
# Talks ONLY to the throwaway container on 127.0.0.1:${AUDIT_PGPORT:-54339}. Never point it elsewhere.
#
#   SRC=<dir holding `git show origin/main:` copies of backend/>   (see VALIDATION.md §0)
#   AUDIT_PGPASS_FILE=<file with the throwaway superuser password>
#   OUT=<evidence dir>   (default docs/schema-audit/evidence)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AUDIT="$(cd "$HERE/.." && pwd)"
SRC="${SRC:?set SRC}"; OUT="${OUT:-$AUDIT/evidence}"; mkdir -p "$OUT" "$OUT/tmp"
DB="$SRC/backend/database"; MIG="$DB/migrations"; MAIN="$SRC/backend/app/main.py"
PY="python3 $HERE/audit_db.py"
SEED="${SEED:-$AUDIT/../../building-blocks/from-design/seed-workspaces.json}"

step() { echo; echo "=================== $*"; }

step "M1 m_schema = shim + schema.sql (the repo's 'reference schema')"
$PY createdb m_schema
$PY load m_schema "$AUDIT/shim/00-supabase-shim.sql" "$DB/schema.sql" | tee "$OUT/m_schema.load.txt"
$PY introspect m_schema "$OUT/snap_m_schema.json"

step "M2 m_fresh = shim only, then the REAL ledger runner (fresh-database branch)"
$PY createdb m_fresh
$PY load m_fresh "$AUDIT/shim/00-supabase-shim.sql"
python3 "$HERE/run_app_runner.py" "$MAIN" m_fresh "$MIG" > "$OUT/m_fresh.runner.txt" 2>&1 || true
grep -c "statement failed" "$OUT/m_fresh.runner.txt" | sed 's/^/failing statements: /' | tee -a "$OUT/m_fresh.summary.txt"
grep -E "_verify_schema|new migration file" "$OUT/m_fresh.runner.txt" | tee -a "$OUT/m_fresh.summary.txt"

step "M3 m_live = shim + verified.sql(executable) + out-of-band stubs + always-run replay x2"
python3 "$HERE/make_verified_executable.py" "$DB/verified.sql" "$OUT/tmp/verified-executable.sql"
$PY createdb m_live
$PY load m_live "$AUDIT/shim/00-supabase-shim.sql" "$OUT/tmp/verified-executable.sql" "$AUDIT/shim/01-live-out-of-band-stubs.sql" | tee "$OUT/m_live.load.txt"
$PY replay m_live "$MIG" "$MAIN" "$OUT/m_live.replay1.json" "pass 1" | tee "$OUT/m_live.replay1.txt"
$PY replay m_live "$MIG" "$MAIN" "$OUT/m_live.replay2.json" "pass 2 (convergence)" | tee "$OUT/m_live.replay2.txt"
$PY introspect m_live "$OUT/snap_m_live.json"
$PY sql m_live "SELECT filename FROM public.schema_migrations ORDER BY 1" > "$OUT/m_live.ledger_after_replay.txt"

step "H  hazard: an UNLEDGERED pre-ledger file re-runs with partial effects (clone BEFORE baselining)"
$PY createdb m_hazard --template m_live
python3 "$HERE/validate_proposal.py" before m_hazard "$OUT/tmp/state_hazard.json" > /dev/null
python3 "$HERE/run_app_runner.py" "$MAIN" m_hazard "$MIG" > "$OUT/hazard_unledgered_rerun.txt" 2>&1 || true
grep -E "NOT recording|_verify_schema" "$OUT/hazard_unledgered_rerun.txt" | tee "$OUT/hazard_summary.txt"
$PY sql m_hazard "SELECT rel.relname, count(con.conname) AS module_checks FROM pg_class rel LEFT JOIN pg_constraint con ON con.conrelid = rel.oid AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%module%' WHERE rel.relname IN ('module_codes','supervisor_invite_codes','user_module_memberships','site_delegations') GROUP BY 1 ORDER BY 1" | tee -a "$OUT/hazard_summary.txt"

step "M3b live ledger = BASELINE of every file present (what d1e99c6 did on 2026-07-11)"
$PY baseline m_live "$MIG" | tee "$OUT/m_live.baseline.txt"

step "M3c the read-only drift-check SQL runs as written (psql inside the container, against the live model)"
docker exec -i matrix-schema-audit psql -U postgres -d m_live -X -v ON_ERROR_STOP=1 -f - < "$AUDIT/live-db-drift-check.sql" > "$OUT/drift_check_on_m_live.txt" 2>&1 && echo "drift-check: OK ($(wc -l < "$OUT/drift_check_on_m_live.txt") lines)" || { echo "drift-check: FAILED"; tail -5 "$OUT/drift_check_on_m_live.txt"; }

step "M4 drift: schema.sql model vs live model"
$PY diff "$OUT/snap_m_schema.json" "$OUT/snap_m_live.json" > "$OUT/drift_schema_vs_live.md"
wc -l "$OUT/drift_schema_vs_live.md"

step "M5 ORM fit (every mapped column must exist) + _verify_schema on both models"
python3 "$HERE/orm_check.py" "$SRC/backend" m_schema --json "$OUT/orm_m_schema.json" > /dev/null
python3 "$HERE/orm_check.py" "$SRC/backend" m_live --json "$OUT/orm_m_live.json" > /dev/null
cat "$OUT/orm_m_schema.json" "$OUT/orm_m_live.json"
python3 "$HERE/run_app_runner.py" "$MAIN" m_schema "$MIG" --verify-only | tee "$OUT/verify_m_schema.txt" || true
python3 "$HERE/run_app_runner.py" "$MAIN" m_live "$MIG" --verify-only | tee "$OUT/verify_m_live.txt" || true

step "M6 vocabularies the two models actually enforce today"
python3 "$HERE/validate_proposal.py" vocab m_schema | tee "$OUT/vocab_m_schema.md" || true
python3 "$HERE/validate_proposal.py" vocab m_live | tee "$OUT/vocab_m_live.md" || true

step "P1 m_prop = clone of m_live; seed existing-style rows BEFORE the proposals"
$PY createdb m_prop --template m_live
python3 "$HERE/validate_proposal.py" before m_prop "$OUT/tmp/state.json" | tee "$OUT/p1_before.md"
$PY introspect m_prop "$OUT/snap_m_prop_before.json"

step "P2 apply proposals with the REAL ledger runner (real migrations + proposals in one dir)"
rm -rf "$OUT/tmp/migdir" && mkdir -p "$OUT/tmp/migdir"
cp "$MIG"/*.sql "$OUT/tmp/migdir/"; cp "$AUDIT"/proposed-migrations/*.sql "$OUT/tmp/migdir/"
python3 "$HERE/run_app_runner.py" "$MAIN" m_prop "$OUT/tmp/migdir" | tee "$OUT/p2_runner_pass1.txt" || true
python3 "$HERE/run_app_runner.py" "$MAIN" m_prop "$OUT/tmp/migdir" | tee "$OUT/p2_runner_pass2.txt" || true

step "P3 idempotency: re-execute EVERY proposal statement twice more (always-run emulation)"
rm -rf "$OUT/tmp/propdir" && mkdir -p "$OUT/tmp/propdir" && cp "$AUDIT"/proposed-migrations/*.sql "$OUT/tmp/propdir/"
$PY replay m_prop "$OUT/tmp/propdir" "$MAIN" "$OUT/p3_replay1.json" "proposals re-run #1" | tee "$OUT/p3_replay.txt"
$PY replay m_prop "$OUT/tmp/propdir" "$MAIN" "$OUT/p3_replay2.json" "proposals re-run #2" | tee -a "$OUT/p3_replay.txt"

step "P4 behaviour after the proposals"
python3 "$HERE/validate_proposal.py" after m_prop "$OUT/tmp/state.json" "$SEED" | tee "$OUT/p4_after.md" || true
python3 "$HERE/orm_check.py" "$SRC/backend" m_prop --json "$OUT/orm_m_prop.json"
$PY introspect m_prop "$OUT/snap_m_prop_after.json"
$PY diff "$OUT/snap_m_prop_before.json" "$OUT/snap_m_prop_after.json" > "$OUT/diff_before_after_proposals.md"

step "P6 cross-check with F3's reference interpreter (third_party/matrix-adapters/runtime.py) persisting into the tables"
python3 "$HERE/f3_runtime_fit.py" m_prop "$OUT/tmp/state.json" "$SEED" | tee "$OUT/p6_f3_runtime_fit.txt" || true

step "P5 the same proposals on a schema.sql-shaped database (what a sandbox built from schema.sql looks like)"
# (a) the hazard: first boot of a schema.sql DB WITH the proposals present baselines them unrun
$PY createdb m_schema_hazard --template m_schema
python3 "$HERE/run_app_runner.py" "$MAIN" m_schema_hazard "$OUT/tmp/migdir" > "$OUT/p5_hazard.txt" 2>&1 || true
grep -E "BASELINED|_verify_schema" "$OUT/p5_hazard.txt"
$PY sql m_schema_hazard "SELECT count(*) AS ledgered_proposals, (SELECT to_regclass('public.tenant_modules') IS NOT NULL) AS tenant_modules_exists FROM public.schema_migrations WHERE filename LIKE '20261004_%'" | tee -a "$OUT/p5_hazard.txt"
# (b) the right order: boot once WITHOUT the proposals (baseline), then boot with them
$PY createdb m_schema_prop --template m_schema
python3 "$HERE/run_app_runner.py" "$MAIN" m_schema_prop "$MIG" > "$OUT/p5_schema_prop.txt" 2>&1 || true
python3 "$HERE/run_app_runner.py" "$MAIN" m_schema_prop "$OUT/tmp/migdir" >> "$OUT/p5_schema_prop.txt" 2>&1 || true
grep -E "BASELINED|statement failed|applied 2026100|NOT recording|_verify_schema" "$OUT/p5_schema_prop.txt" | head -60

echo; echo "done; evidence in $OUT"
