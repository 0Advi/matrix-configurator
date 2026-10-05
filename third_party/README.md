# third_party/

Vendored third-party code, kept **verbatim** with its licence. Each component has a `VERSION` file that
records the source URL, commit, release artefact hash and the sha256 of every file. Our own glue lives in
`matrix-adapters/` and is clearly separated. Attribution for everything is in [`/THIRD_PARTY.md`](../THIRD_PARTY.md).
The audit is in [`/docs/oss/PROVENANCE-AUDIT.md`](../docs/oss/PROVENANCE-AUDIT.md).

| Dir | What | Version | Licence | Kind |
|---|---|---|---|---|
| `json-logic-js/` | JsonLogic evaluator (JS) — the reference semantics | 2.0.5 (npm) = git `c5c73601` | MIT | vendored verbatim |
| `panzi-json-logic/` | JsonLogic evaluator (Python port of json-logic-js), import name `json_logic` | 1.0.1 (PyPI) = git `f55bf413` | MIT | vendored verbatim |
| `json-logic-compat-tables/` | Community cross-implementation JsonLogic test suites (data only) | git `dfc0601e` | Apache-2.0 | vendored verbatim |
| `rjsf-check/` | Proof that `@rjsf/core` renders and validates our compiled stage forms. `package.json` + lockfile only; `node_modules/` is gitignored | `@rjsf/*` 6.11.0 | Apache-2.0 (rjsf), MIT/BSD deps | npm dependency, **not vendored** |
| `matrix-adapters/` | **First-party** glue: gate compiler (py + js), form compiler, reference custom-module runtime, tests on real data | — | project code | ours |

## Run everything

```bash
# one-time
python3 -m venv .venv && .venv/bin/pip install jsonschema==4.26.0     # backend validator, pinned
(cd third_party/rjsf-check && npm ci)                                 # rjsf 6.11.0, exact versions from the lockfile

# 36 tests: compat suites, JS-vs-Python differential, real gates, real forms (rjsf + ajv vs jsonschema), runtime, F2 row mapping
.venv/bin/python -m unittest discover -s third_party/matrix-adapters/test -t third_party/matrix-adapters/test
```

Needs Node ≥ 18 on `PATH`. The tests drive the JS side through `matrix-adapters/cli.mjs`. Without
`jsonschema` or `rjsf-check/node_modules`, the form and runtime tests that need them are skipped. They do
not fail.

## Rules for this directory

* Never edit a vendored file. To upgrade, re-download the release, diff it, then update `VERSION` and
  `/THIRD_PARTY.md`.
* Only permissive licences (MIT / Apache-2.0 / BSD / ISC) are vendored here. LGPL, AGPL and bespoke-licence
  code (SpiffWorkflow, NocoBase, …) is never copied. It can only be used as an unmodified external dependency
  or service; see `docs/oss/REPO-SURVEY.md`.
