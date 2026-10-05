# F3 progress — OSS gap-filling + provenance audit

Resumable log. Each step lists its outputs on disk.

| # | Step | State | Output |
|---|---|---|---|
| 0 | Read context docs (PHASE2-PLAN, CONTRACT, READMEs, CATALOG, SEED-VS-REALITY, concept-map, primitives-map) | done | — |
| 1 | Provenance audit (hashes, licences, images) | done | `docs/oss/PROVENANCE-AUDIT.md`, `THIRD_PARTY.md` |
| 2 | Gap inventory | done | `docs/oss/GAP-ANALYSIS.md` |
| 3 | Repo survey (gh api + shallow clones) | done | `docs/oss/REPO-SURVEY.md` |
| 4 | Adopt-now pieces + tests | done (36 tests green) | `third_party/`, `docs/oss/for-F4.md` |
| 5 | Operaton spike (optional, ≤45 min) | done — SPIKE OK on re-run; torn down | `docs/oss/OPERATON-SPIKE.md` |
| 6 | Gap analysis + final report | done | `docs/oss/GAP-ANALYSIS.md`, `docs/reports/F3.md` |

Scratch / clones: `/private/tmp/claude-501/-Users-aditya-Desktop-bd/9574cf09-a5c7-44b0-901f-c5c723c0795b/scratchpad/F3`

## Log
- 2026-10-04 — resumed after rate-limit interruption; context re-read; output dirs created.
- Provenance: all vendored hashes/SRI/npm shasums re-verified and match; zip entries byte-identical to sources; NocoBase image digest 4d570583…, 4 packages ship only the NocoBase Agreement; dc-runtime has no licence (flagged). → `docs/oss/PROVENANCE-AUDIT.md`.
- Survey metadata: `scratchpad/F3/repo-meta.tsv`. json-logic compat-tables results read: json-logic-js 278/278 + panzi 277/278 on the classic suite.
- Decision so far: gates = JsonLogic dialect; vendor json-logic-js 2.0.5 (npm tgz sha1 55f0c687…) + panzi-json-logic 1.0.1 (sdist sha256 df80ec39…), both verified == git commits c5c7360 / f55bf41. Forms = rjsf 6.11.0 as npm dep.
- Vendored json-logic-js 2.0.5, panzi-json-logic 1.0.1, compat-tables suites (VERSION files written). First-party `third_party/matrix-adapters/gates.{py,mjs}` (manifest gate/stage-gate/field-condition/roll-up → matrix-gate/1 JsonLogic + lint).
- Tests (17, green): JS 278/278 classic suite; Py 277/278 (known reduce-init bug, lint-forbidden); differential 548 lint-clean cases → 0 disagreements (19 pre-lint divergences closed by 5 lint rules); py==js compiled rules on all 4 real manifests; 407 gate verdicts py==js across every production-flow prefix; 1607 roll-up verdicts == v5-port evaluateRollup.
- Forms: `third_party/matrix-adapters/forms.py` (fields → draft-07 JSON Schema + rjsf uiSchema; hint parser) + `third_party/rjsf-check/` (@rjsf/* 6.11.0 exact, 21 pkgs, all MIT/Apache/BSD). Test: 123 real stage forms SSR-rendered by rjsf, every field present; 725 submissions → ajv8 == jsonschema 4.26.0 on 725/725. 12 distinct free-text hints unparsed (G-F evidence).
- Next: runtime reference interpreter (in-app, pure Python) + test; then Operaton spike; then docs.
- Runtime: `third_party/matrix-adapters/runtime.py` reference interpreter (tiers, send-back/loops, forward-only, stage gates, delegation, observer, admin override, SoD, self-approval collapse, version pinning, hash-chained audit). 12 tests green: 11 real custom modules (Starbucks/BK seeds + 3 wizard templates) end to end; full production flow (9 modules) completes with gates opening bd > legal > finance_ca > design > nso > pex > project > launch_approval > financial_closure; findings: v5 roll-up vocabulary parks Legal+NSO (8 fields need outcome maps, G-E); wizard templates mark text/file/number as affects_outcome (unusable by roll-ups).
- Full adapter suite: 34 tests green.
- Spike (01:32–01:47): Operaton 2.1.5 image pulled (815 MB, 88 s), BPMN generated from finance_ca (`docs/oss/spikes/operaton/`). **Not executed**: Docker daemon could not start ANY new container (F1's `f1probe` hung since 01:20, F2's `matrix-schema-audit` stuck in Created, my no-op postgres probe stuck). Killed only my own clients, removed my 3 containers + the image. Ready-to-run `run_spike.sh` left. SpiffWorkflow 3.2.0 ran the same BPMN end to end incl. send-back + JSON round-trip (`docs/oss/spikes/spiffworkflow/run_spiff.py`, SPIFF OK).
- Next: docs (REPO-SURVEY, GAP-ANALYSIS, for-F4, OPERATON-SPIKE, READMEs, THIRD_PARTY.md) + final report.
- Runtime aligned with F2's proposed tables (`module_record_row`, `approval_row`): 18 module_records + 42 module_approvals rows fit F2's CHECKs. Findings for F2/F4: admin-only stages with fields (Design GFC, PEx admin review, Launch admin review) → mapped to verdict 'approved'; admin-override submissions on executive/supervisor steps still conflict with F2's guard. Field-less first steps are now 'approve' steps. 36 tests green.
- Resumed after 2nd rate-limit cut. Docker recovered (per lead) → re-running Operaton spike (≤30 min incl. re-pull), started $(date +%T).
- Operaton spike RE-RUN 07:06–07:08 after Docker recovered: **SPIKE OK** — pull 83 s (815 MB), REST up 8 s, 503 MiB, deploy + start + 5 REST task completions (incl. send-back) → history COMPLETED (801 ms). REST was reachable without credentials. Container auto-removed (trap), image deleted, port 18080 free. Log: `docs/oss/spikes/operaton/spike-run-2026-10-04.log`.
- CSP/ajv tested: under `--disallow-code-generation-from-strings` rjsf's ajv8 validator fails every submission (even valid). Recorded in for-F4 §2 with 3 options.
- Docs written: for-F4.md, REPO-SURVEY.md. Remaining: OPERATON-SPIKE update, GAP-ANALYSIS, THIRD_PARTY.md, README counts, F3.md.
- DONE: GAP-ANALYSIS, OPERATON-SPIKE (real results), THIRD_PARTY.md, READMEs updated; final suite 36/36 OK; vendored files re-verified verbatim; no f3-* containers or operaton images left. Final report `docs/reports/F3.md`.
