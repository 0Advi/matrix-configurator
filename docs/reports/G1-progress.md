# G1 — AI-agent configurator: progress log

Resume from the last entry. Final report: `docs/reports/G1.md`.

## 2026-10-05 — M0 recon (done)
- Read PHASE2-PLAN (D2: NocoBase = design-time drafts via the :4300 server; app DB = run-time), CONTRACT, web README/CHANGES,
  v5-model, building-blocks (CATALOG, load-dc, validation.mjs, schemas, vocabularies, seeds, flow-adapter), nocobase client,
  F4-API + F4a report, F4b progress + in-app host bridge (publish order: validate -> provision on 404 -> v5 publish -> POST release,
  `source_ref = configurator:<ref>@v<N>`), app validator (`module_runtime/validate.py`, `forms.py`, `gates.py`).
- operaton-plat read via `gh api` at `fc65499834cfa8d5e47ca2bb5266899117555d36` (README, matrix.py op_* + validate, mcp_server.py,
  prompt-to-process.html, catalogue.json). Repo has no licence file; user owns it. workspace.json NOT read (demo passwords).
- Stack (read-only checks): :4300 `nocobase` mode, :8000 health ok, :5173 up. Draft store currently holds 2 human workspaces
  (`ws_aditya_test`, `ws_chai_point_retail`) — must never be clobbered.
- Decisions: store = `/cfg/state` (ETag/If-Match, server projections, same blob the browser hydrates). Mutations run through the
  REAL v5 `Component` (load-dc.mjs) where v5 has the action (createWorkspace, addBuiltin, wizard+wizSave, applyToggle, publish);
  stage/field/gate/tier/roll-up edits are pure edits on the same stash shape. Findings/diff/manifest = validation.mjs (parity-tested
  against the class). Inputs = JSON Schema per op (one definition for CLI validation + MCP inputSchema). MCP = official SDK low-level
  `Server` over stdio. Admin login is 10/5 min per IP (shared with F4b) -> token cached in-process only; CLI `run` mode for batches.

## 2026-10-05 — M1 core written (resumed after a usage-limit interruption)
- On disk: `agent-configurator/{package.json, package-lock.json, .gitignore}` (dep: `@modelcontextprotocol/sdk` 1.32.0 exact, 94 pkgs
  in the lock), `lib/{errors,config,store,app-api,v5,model,hints,ops}.mjs` (27 ops incl. publish + migrate_running stub).
- Coordinator: the user's `ws_aditya_test` and `ws_chai_point_retail` must never be modified/deleted. Adding (a) a runtime
  merge-around invariant on every write (all workspaces except the target must be byte-identical to what was read, else refuse),
  (b) `CFG_PROTECTED_WORKSPACES` (ids the agent may read but never write/delete; used for the live E2E), (c) a test proving it.
- Next: invariant + protection, CLI, MCP server, tests, live E2E.

## 2026-10-05 — M2 front doors + tests green
- `bin/cfg.mjs` (CLI: `ops`, `help <op>`, `<op> --json`, `run --file steps.json` = one process / one sign-in),
  `mcp-server.mjs` (SDK low-level `Server`, stdio, 27 tools with read-only/destructive annotations + server instructions).
- Merge-around invariant (`assertMergeAround`) on every write + `CFG_PROTECTED_WORKSPACES`; tested.
- `node --test` in agent-configurator: **47/47 pass** (ops 21, parity 2, publish 12, store 9, mcp+cli 2 + 1 suite-level).
  Fakes: real web/server.mjs handler + test-only fake NocoBase; fake platform API with random creds (asserted never output).
- Next: live E2E against the shared stack (CLI only; protected user workspaces; ≤ 3 admin sign-ins; 1 provisioning).

## 2026-10-05 — M3 live E2E (CLI only) + lead heads-up
- Live E2E done via `node bin/cfg.mjs run --file …` with `CFG_PROTECTED_WORKSPACES=ws_aditya_test,ws_chai_point_retail`:
  create `Agent Coffee` (template bluetokai) → disable `pex` → custom `fitout_qa` (2 stages; [executive→supervisor] then
  [supervisor]; gate legal:approved) → validate (local ready, app dry run 0 errors/0 warnings) → publish dry run → publish
  confirm: provisioned tenant ref **ws_agent_coffee**, code `AGENTC-2313B9A4C05CAF00`, app release v1
  (`configurator:ws_agent_coffee@v1`, live), registry: project_excellence disabled, fitout_qa custom `/m/fitout_qa`.
  Setup code redacted by the harness (never stored) → BA account stays unclaimed. 2 admin sign-ins total, 1 provisioning.
- Draft visible in GET :4300/cfg/state and via the :5173 proxy; visual configurator (Browser pane) shows it — screens in
  `docs/reports/G1-screens/`. User workspace fingerprints unchanged (aditya-test fa651ec9…, chai-point c685ce28…).
- Lead: G3 will restart :8000/:5173 → app client now retries ~16 s with backoff (connection refused always; 502/503/504 +
  transport errors only for idempotent calls — never re-sends provision/publish). Tests 50/50.
- Correction from lead: `chai-point-retail` was created by F4b's browser journey (not user data, leave alone);
  `aditya-test` IS the user's. `migrate_running` stays a stub (lead will wire it to G3's API later).

## 2026-10-05 — M4 browser check, cleanup, docs (done)
- Browser pane (own tab, viewport reset to desktop for clicks; DOM pointer events used once under emulation for the
  wide shot): picker shows "Agent Coffee · 8 built-in (1 off) · 1 custom · v1"; canvas shows Cafe Fit-out QA (CUSTOM,
  /m/fitout_qa, gate "Available when Legal & Compliance is approved"), Project Excellence OFF, "No findings · v1 live ·
  v2 draft". 4 screens in `docs/reports/G1-screens/`. Tab closed. Opening the workspace caused no store change.
- Live read-only MCP round trip (SDK client → mcp-server.mjs → :4300): 27 tools; protected write refused.
- Cleanup via CLI: `delete_workspace agent-coffee` (dry run, then confirm). Store back to `ws_aditya_test`,
  `ws_chai_point_retail`; fingerprints unchanged (fa651ec9…, c685ce28…). App tenant **ws_agent_coffee /
  AGENTC-2313B9A4C05CAF00** remains (no delete API; BA unclaimed, setup code never stored). `cfg_releases` keeps v1.
- Test fakes moved to `testkit/` (node --test was counting the helper file): **49/49** real tests.
- THIRD_PARTY.md §H appended; README + .mcp.example.json written. Final report: `docs/reports/G1.md`.
