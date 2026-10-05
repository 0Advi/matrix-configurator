# F1 progress (resume notes)

- [x] 2026-10-04 01:12 — `app/` created from `git archive origin/main` (3d4f277).
- [x] 01:13 — backend venv (python3.12, requirements.lock.txt + `pip install --no-deps -e .`) at `app/backend/.venv`; `npm ci` in `app/frontend` OK.
- [x] 01:15 — `app-stack/.env` (generated DB password, gitignored), `app-stack/.gitignore`, `db-init/00-supabase-shim.sql`, `docker-compose.yml` written.
- [!] 01:16 — BLOCKER: first `docker compose up` used a bind mount of `app-stack/db-init` (under ~/Desktop). Docker Desktop's
      file-sharing approval for that path never returned (likely a pending macOS "Docker wants to access Desktop folder"
      prompt), and since then EVERY new container start on this Docker Desktop hangs in `Created` (also F2's
      `matrix-schema-audit`). Running NocoBase containers unaffected. Bind mount removed from compose (shim is now streamed in
      via `docker compose exec -T db psql`). Needs: someone to answer the macOS prompt (or restart Docker Desktop, which would
      bounce NocoBase — not done).
- [x] 01:27–01:40 — written (untested until Docker recovers): `app/backend/.env`, `app/frontend/.env.local` (fresh secrets),
      `app-stack/{lib.sh,start.sh,stop.sh,status.sh,reset-db.sh}`, `bootstrap/{gen_env.py,bootstrap_db.py}`,
      `storage-stub.mjs` (Supabase Storage stand-in on :54331), `smoke-existing.mjs`.
      Bootstrap path chosen: shim -> schema.sql -> replay all migrations once (failures tolerated, HOLD 202606145 skipped)
      -> full ledger. Reason: neither pure path works — migrations need pre-existing base tables (no from-zero path),
      schema.sql alone misses e.g. password_reset_requests.reset_token_hash/token_expires_at (approve would 500),
      tenants_workspace_code_uidx, quality_audit_reports, area_sqft numeric, RLS.
- [ ] NEXT once `docker ps` shows matrix-app-db-1 Up: `cd app-stack && ./start.sh`, inspect run/bootstrap drift report,
      `node smoke-existing.mjs`, browser check, docs (README, EXTERNAL-DEPS, SANDBOX-CHANGES), final report.
- [x] ~01:33 — WORKAROUND for the wedged Docker Desktop API proxy: starting the container through the raw daemon socket works
      and host port publishing still works:
      `DOCKER_HOST=unix://$HOME/Library/Containers/com.docker.docker/Data/docker.raw.sock docker start matrix-app-db-1`
      (start.sh now falls back to this automatically). F2's `matrix-schema-audit` is stuck the same way (not touched by F1).
- [x] ~01:35 — DB bootstrapped (63/63 ledger rows; 345/365 stmts in pass 1, +6 in pass 2; 14 benign failures), stack up via
      `./start.sh` (db, storage :54331, backend :8000, frontend :5173). Fixed start_daemon so pidfiles hold the real PIDs.
      (NB: earlier timestamps in this file were approximate; real clock ~01:40.)
- [x] ~01:50 — stop→start cycles verified (full stop incl. db; apps-only restart); smoke 41/41 twice; browser check done
      (screens in docs/reports/F1-screens/); README, EXTERNAL-DEPS, SANDBOX-CHANGES written. Coordinator: Docker recovered.
- [ ] NEXT: one more full stop→start through the normal compose path (no fallback), final smoke, write F1.md, handback.
- [x] final — normal compose stop→start (no fallback, 9 s); reset-db.sh with backend running OK; smoke 41/41 on fresh DB
      (tenant SMOKER-5B498BA002273D04); docs/reports/F1.md written. Stack left RUNNING. F1 DONE.
