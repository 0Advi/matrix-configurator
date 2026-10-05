# Spike — one configurator module run as BPMN (Operaton 2.1.5 and SpiffWorkflow 3.2.0)

**Goal.** Find out whether a BPMN engine adds enough over an in-app interpreter to be worth adopting for
custom modules. **Time used:** about 15 min on a blocked first attempt, plus 2 min for the successful re-run,
plus about 10 min for SpiffWorkflow.

## What was built

* `spikes/operaton/manifest_to_bpmn.py` turns one manifest module into executable BPMN 2.0. It follows the
  same rules as the in-app runtime (`third_party/matrix-adapters/runtime.py`):
  * each stage × tier step becomes a `userTask` with `candidateGroups = role`;
  * the first step of a stage carries the stage fields as `formData`;
  * every later step gets an `exclusiveGateway` where `decision == 'send_back'` goes to the previous step;
  * the terminal stage leads to the end event.
  * It does not emit BPMN-DI (diagram) shapes. The engine does not need them, but bpmn-js would.
* **Input:** `finance_ca` from `building-blocks/from-matrix-bd/matrix-bd-flow.json`. Its stages are
  CA code & KYC (executive), then supervisor review, then admin approval, with production's "send back to
  pending".
* **Output:** `spikes/operaton/finance_ca.operaton.bpmn` and `finance_ca.camunda.bpmn`.

## Operaton — **executed: SPIKE OK** (`spikes/operaton/run_spike.sh`, log `spike-run-2026-10-04.log`)

| Step | Result |
|---|---|
| Image | `operaton/operaton:2.1.5`, Apache-2.0, digest `sha256:ed5d68637e2024dee93c3de19472d3ba4e835073c7c8d66f2bd3f36c15616892`, **815 MB**, pulled in 83 s |
| Start | `docker run -p 127.0.0.1:18080:8080`, embedded H2. `GET /engine-rest/engine` was up after **8 s**; `/version` returned `2.1.5` |
| Memory | **503 MiB** at idle after deploy |
| Deploy | `POST /engine-rest/deployment/create` (multipart) gave `finance_ca:1:…`. The `operaton:` namespace and the JUEL conditions were accepted as generated. |
| Start instance | `POST /process-definition/key/finance_ca/start` with `businessKey=site-1` |
| Tasks | 5 × `GET /task?processInstanceId=…` then `POST /task/{id}/complete`, with typed variables `{value, type}`. Path: **s1 executive → s2 supervisor (send_back) → s1 executive → s2 supervisor → s3 business_admin** |
| History | `GET /history/process-instance/{id}` returned `COMPLETED` (801 ms wall time). The activity history replays the send-back loop exactly. |
| Teardown | The container was removed by the script's `trap`. The image was deleted with `docker rmi`. Port 18080 is free. |

Observations:

* **The REST API answered without credentials.** In this image, `engine-rest` is open by default, so it must
  never be published beyond loopback. Adopting it means turning on auth and syncing Matrix users and roles
  into Operaton's identity service, or putting it behind the app.
* Task routing (`candidateGroups`) is only a filter. Operaton does not know Matrix tiers, site delegation,
  separation of duties or the business-admin bypass, so the app would still enforce all of them.
* Typed variables (`{"value":…,"type":"Long"}`) and form fields are Operaton's own model. Field validation
  against our JSON Schema would still happen in the app.
* A first attempt at 01:34 was blocked because the local Docker daemon could not start any new container.
  F1's and F2's probes were stuck the same way. Docker recovered by 07:06; the lead had verified it.

## SpiffWorkflow — **executed: SPIFF OK** (`spikes/spiffworkflow/run_spiff.py`)

The same BPMN (Camunda namespace) ran in-process on Python 3.13 with `SpiffWorkflow==3.2.0` + `lxml`:

```
trace: s1_0_executive > s2_0_supervisor (send_back) > s1_0_executive > s2_0_supervisor > s3_0_business_admin
completed: true   first-task formData fields: kyc_verified, ca_code, finance_amount
serialized workflow per step: 9.3–11.3 KB JSON (deserialized and resumed after every step)
```

## Comparison on the same module

| | In-app interpreter (`runtime.py`) | SpiffWorkflow 3.2.0 | Operaton 2.1.5 |
|---|---|---|---|
| Licence | ours | **LGPL-3.0**: unmodified pip dependency only | Apache-2.0 |
| Runs where | inside FastAPI | inside FastAPI | separate JVM service, 815 MB image, ~0.5 GB RAM, own DB schema |
| Send-back / loops | yes (tested) | yes (tested) | yes (tested) |
| Gate language | JsonLogic, same in browser and backend | **Python** expressions | **JUEL** (`${…}`): the generated BPMN must be rewritten per engine |
| Tiers, delegation, SoD, observer, admin bypass | yes (tested) | **no** (app code) | **no** (app code; `candidateGroups` only filters) |
| Field validation | JSON Schema (rjsf + jsonschema, tested) | no (formData is metadata) | its own form model |
| Cross-module and stage-level gates | yes, via site facts (tested) | separate processes or messages | parent process / message correlation |
| Version pinning | release id on the case (tested) | spec stored per workflow | definition version per instance + **migration API** |
| State you store | explicit JSON row mapped to F2's tables | opaque ~10 KB blob | engine tables (`ACT_*`) |
| Timers, escalations, DMN | not yet | yes | yes (most mature) |
| Ops burden | none | none | high |

## Verdict

* **Custom-module runtime now: the in-app interpreter.** It is the only option that already does
  authorization, validation, gates and pinning the way Matrix needs, with nothing new to operate.
* **SpiffWorkflow: later.** It is the in-process upgrade path if modules need parallel branches, timers or
  BPMN import. The BPMN generator already exists.
* **Operaton: later.** Choose it only if customers need BPMN/DMN interchange, long-running timers and
  escalations, or bulk instance migration. It works and was easy to drive (8 s start, clean REST). The cost is
  a second runtime with its own identity model and open-by-default REST, and auth parity is still our code.
