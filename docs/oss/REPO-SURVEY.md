# OSS repo survey — candidates for each gap

Method (2026-10-04):
* `gh api repos/<r>` for licence SPDX, stars, last push and default branch, plus `…/releases`, across 49 repos.
* `gh api repos/<r>/license` to read the **actual licence text** wherever GitHub said NOASSERTION.
* `npm view` / PyPI JSON for release versions and hashes.
* Shallow clones (in the session scratchpad) of the json-logic implementations and the compat suite, which
  were read and executed.
* SpiffWorkflow 3.2.0 and rjsf 6.11.0 installed and run on our data. Operaton 2.1.5 pulled and spiked
  (see `OPERATON-SPIKE.md`).

Verdicts: **adopt-now** (in F4's scope) · **spike** (worth a time-boxed trial next) · **later** (right tool,
wrong time) · **reference** (read the design, never copy) · **reject**.

## Workflow / process engines

| Repo | Licence (verified) | Activity | Fit for Matrix | Effort | Verdict |
|---|---|---|---|---|---|
| **nocobase/nocobase** v2.2.20 | **NocoBase License Agreement**: bespoke, non-OSI. Apache-2.0 is incorporated, but the supplementary terms prevail; §5.4 bans public low-code SaaS. 4 packages in the image ship only the Agreement. | 24.4k★, pushed 2026-09-30 | Rich workflow engine. Manual node modes `0` single / `1` all-must-sign / `-1` any (`plugin-workflow-manual/src/server/actions.ts`: `getAllModeStatus`, `getAnyModeStatus`). Workflow revisions use `key` + `current` (`plugin-workflow/src/common/collections/workflows.ts`). The approval UX is a commercial plugin. | — | **reference only.** Borrow the *designs*: the all/any/single quorum for G1/G-I co-owned stages, and revision keys for version pinning. Keep it as the design-time store (D2). Copy no code. |
| **operaton/operaton** 2.1.5 | Apache-2.0 | 483★, very active (pushed 2026-10-03), Camunda 7 fork, monthly releases | Full BPMN 2.0 + DMN 1.3, external tasks, process-instance migration, history. A JVM service: image 815 MB, its own DB schema and users. | High (service + integration + auth sync) | **later** (spike prepared, `spikes/operaton/run_spike.sh`) |
| **sartography/SpiffWorkflow** 3.2.0 | **LGPL-3.0** | 1.9k★, pushed 2026-09 | Pure-Python BPMN/DMN, in-process with FastAPI. **Ran our generated BPMN end to end** (send-back loop, JSON-serialised state ~10 KB/case). It does no authorization or field validation, and conditions are Python, not JUEL. | Medium | **spike → later.** Use it only as an unmodified pip dependency if linear stages stop being enough. |
| sartography/spiff-arena | LGPL-2.1 | 147★ | A whole platform (Flask + React + bpmn-js modeler) built on SpiffWorkflow | High | reject (overlaps the configurator) |
| camunda/camunda (8.x) | Camunda License 1.0 for Zeebe/Operate/Tasklist (source-available, not OSI) plus Apache parts | 4.3k★ | Cloud-native engine; production use needs a licence | — | **reject** (licence) |
| flowable/flowable-engine | Apache-2.0 | 9.6k★, active | BPMN/CMMN/DMN on the JVM, the same class as Operaton | High | later (alternative to Operaton) |
| temporalio/temporal | MIT | 23k★ | Durable execution with workflow-as-code. Strong, but it is a cluster to run and has no BPMN or human-task model. | High | reject for now |
| conductor-oss/conductor | Apache-2.0 | 32k★ | JSON workflow orchestration (JVM + Redis/ES) | High | reject for now |
| viewflow/viewflow | **AGPL-3.0** | 2.9k★ | Django workflow library | — | **reject** (AGPL + Django) |
| statelyai/xstate | MIT | 30k★ | Statecharts in JS; possible for client-side preview only | Low | later (not needed) |
| fgmacedo/python-statemachine, pytransitions | MIT | 1.3k★ / 6.6k★ | FSM libraries; our tier chain is simpler than an FSM DSL | Low | reject (no gain over `runtime.py`) |

## Gate / condition language

| Repo | Licence | Activity | Notes (tested) | Verdict |
|---|---|---|---|---|
| **jwadhams/json-logic-js** 2.0.5 | MIT | dormant since 2024-07, 1.5k★, the de-facto reference | 278/278 on the classic suite; 475 lines, no deps | **adopt-now (vendored)** |
| **panzi/panzi-json-logic** 1.0.1 | MIT | dormant since 2021, 26★ | Faithful Python port. 277/278: `reduce` does not evaluate a rule-valued initial value, which our lint forbids. Agrees with json-logic-js on **all 548** lint-clean compat cases. | **adopt-now (vendored)** |
| json-logic/compat-tables | Apache-2.0 | active 2026-09 | 1,138 cross-implementation cases in 49 suites, used for our differential test | **adopt-now (test data)** |
| json-logic/json-logic-engine 5.0.7 | MIT | active, 99% on compat | Faster and more complete, but there is no Python twin at that level, and the compile mode uses `new Function` | later (if JS perf matters) |
| nadirizr/json-logic-py / json-logic-qubit | MIT | dead (2017) / fork | Weaker JS parity than panzi in the compat tables | reject |
| Viicos/jsonlogic (python-jsonlogic 0.2.0) | MIT | active | Typed, but deliberately **different** semantics (var syntax), so it breaks JS parity | reject for gates |
| google/cel-spec + cel-python / cel-js | Apache-2.0 / MIT | active | A real expression language with types. Cerbos uses it. A heavier migration from v5's `{match, conds}`. | later (if gates outgrow JsonLogic) |
| bpmn-io/feelin, camunda/feel-scala | MIT / Apache-2.0 | active | DMN FEEL interpreters; only relevant with DMN | later (with DMN) |

## Forms from field definitions

| Repo | Licence | Activity | Notes (tested) | Verdict |
|---|---|---|---|---|
| **rjsf-team/react-jsonschema-form** 6.11.0 | Apache-2.0 | very active (2026-09-28), 15.9k★ | React ≥18 peer. 21-package tree (no lodash). **Rendered all 123 real stage forms** (SSR). Its ajv8 verdicts equal jsonschema's on 725/725 submissions. Needs `'unsafe-eval'` unless the validator is swapped (see for-F4 §2). | **adopt-now (npm dep, exact pin)** |
| python-jsonschema/jsonschema 4.26.0 | MIT | active | Backend validation of the same schema | **adopt-now (pip, exact pin)** |
| ajv-validator/ajv 8.20.0 | MIT | active | Comes in through rjsf; uses code generation | (transitive) |
| @cfworker/json-schema 4.1.1 | MIT | 2025-01 | Interpreting validator with no eval, for a strict CSP | later (before CSP enforcement) |
| eclipsesource/jsonforms | MIT | active, 2.7k★ | Good, but needs its own UI-schema dialect and renderer set | reject (rjsf is a closer fit) |
| alibaba/formily | MIT | slowing (2025-06) | NocoBase's form layer; heavy | reject |

## Policy / authorization

| Repo | Licence | Activity | Fit | Verdict |
|---|---|---|---|---|
| **cerbos/cerbos** v0.56.0 (+ `cerbos-sdk-python`, `-javascript`) | Apache-2.0 (open core; Cerbos Hub is commercial) | very active, 4.6k★ | YAML resource policies + derived roles + CEL conditions, running as a stateless PDP (Go) sidecar. It fits "ceiling ⊇ granted", separation of duties and delegation conditions, and gives an audit log of decisions. It adds a service plus a policy-sync step at publish. | **spike** (after F4; generate policies from `permissions[]` at publish) |
| openfga/openfga v1.21.0 (+ python-sdk) | Apache-2.0 (CNCF) | very active, 5.9k★ | Zanzibar ReBAC; strong for per-site delegation graphs at scale. It is a service with its own DB. | later |
| apache/casbin-pycasbin / node-casbin | Apache-2.0 | active | In-process RBAC/ABAC with a model DSL | later (in-process alternative to Cerbos) |
| open-policy-agent/opa | Apache-2.0 | very active | General-purpose Rego; heavier to author | reject for now |

## Graph canvas / BPMN interchange

| Repo | Licence | Fit | Verdict |
|---|---|---|---|
| xyflow/xyflow (`@xyflow/react` 12.12.0) | MIT | Node/edge canvas for a native (non-dc-runtime) configurator, with stage-level gates as edges | later (when the configurator is rebuilt natively) |
| dagrejs/dagre | MIT | Auto-layout for the module graph | later (with xyflow) |
| kieler/elkjs | **EPL-2.0** (weak copyleft) | Better layouts; fine as an unmodified dependency, never copy | later, dependency only |
| bpmn-io/bpmn-moddle 10.3.1 | MIT | Read/write BPMN XML in JS, e.g. export the manifest to BPMN. Our Python generator `spikes/operaton/manifest_to_bpmn.py` already does this without a dependency. | later |
| bpmn-io/bpmn-js 18.31.0, dmn-js | **bpmn.io licence**: MIT-like plus a mandatory, fully visible bpmn.io **watermark** | BPMN editor/viewer | later only if a BPMN UI is wanted, and only if the watermark is acceptable |

## Multi-tab merge / concurrency, audit

| Repo | Licence | Fit | Verdict |
|---|---|---|---|
| benjamine/jsondiffpatch | MIT | 3-way diff/merge of workspace documents (would replace the 409 "server wins") | later |
| Starcounter-Jack/JSON-Patch (fast-json-patch) | MIT | RFC 6902 patches for per-workspace edits | later |
| yjs/yjs, automerge/automerge | MIT | CRDT real-time collaboration; overkill for a few admins | reject for now |
| sqlalchemy-continuum | BSD-3 | Row versioning for SQLAlchemy models | later (the app has `audit_logs`; `runtime.py` hash-chains events) |
| pyeventsourcing/eventsourcing | BSD-3 | Event-sourcing framework | reject (too invasive) |

## Licence watch-list (never copy source from these)

NocoBase (bespoke) · SpiffWorkflow (LGPL-3.0) · spiff-arena (LGPL-2.1) · viewflow (AGPL-3.0) ·
Camunda 8 (Camunda License 1.0) · elkjs (EPL-2.0) · bpmn-js/dmn-js (watermark clause).
