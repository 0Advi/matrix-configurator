# matrix-adapters — first-party glue (not third-party code)

This is the small layer that turns a **published configurator manifest** into something the app can run.
It is built on the vendored engines next to it. F4 copies these files into `app/`; see
[`docs/oss/for-F4.md`](../../docs/oss/for-F4.md).

| File | Purpose | Depends on |
|---|---|---|
| `gates.py` / `gates.mjs` | Compile gates into the **matrix-gate/1** JsonLogic dialect: entry gates (all/any), stage-level conditions, field conditions and roll-ups. Also a dialect **lint** and evaluation. The two files are twins: they produce byte-identical rules and identical verdicts. | `panzi-json-logic` / `json-logic-js` |
| `forms.py` | Turn stage fields into draft-07 JSON Schema + rjsf uiSchema, with a validation-hint parser. Backend validation uses `jsonschema`. | `jsonschema==4.26.0` (backend) |
| `runtime.py` | Reference **custom-module runtime** (+ `module_record_row` / `approval_row` mapping onto F2's proposed tables), pure functions over a JSON `state` per case. It covers: <br>• tier chains, send-back and loops, forward-only verdicts<br>• stage gates, delegation, observer, admin override<br>• separation of duties, self-approval collapse<br>• version pinning, hash-chained audit events | `gates.py`, `forms.py` |
| `cli.mjs` | Test bridge so the Python tests can drive the JS side. | `gates.mjs` |
| `test/` | 36 `unittest` tests on the project's real data (see below). | node, jsonschema, rjsf-check |

## Evidence (latest run, 2026-10-04)

```
Ran 36 tests in ~4.5s — OK
  differential: 548 lint-clean compat cases, 0 disagreements          (json-logic-js vs panzi, all 49 suites)
  json-logic-js 278/278 classic suite; panzi 277/278 (known reduce bug — rejected by lint)
  gate verdicts compared across languages: 407                         (every prefix of the production flow)
  roll-up verdicts: 1607 cases, 0 differ from the v5 port              (building-blocks validation.mjs)
  compiled 123 stages / 260 fields; 12 distinct free-text hints kept as help text
  rjsf rendered 123 stage forms; 725 submissions validated, ajv8 == jsonschema on 725
  custom modules run end to end: 11                                    (Starbucks/BK seeds + 3 wizard templates)
  production flow: 9 modules completed, 105 audit events, open order:
    bd > legal > finance_ca > design > nso > pex > project > launch_approval > financial_closure
  v5 roll-up vocabulary alone parks legal + nso; 8 fields need an outcome map (gap G-E)
  F2 alignment: 18 module_records rows, 42 module_approvals rows fit F2's proposed CHECKs
```

## The matrix-gate/1 dialect

The dialect is JsonLogic restricted to `and or ! !! if === !== < <= > >= in var missing missing_some all
some none filter reduce +`. On top of that, 5 lint rules close every JS/Python divergence the compat suites
exposed:

1. Comparisons take exactly 2 arguments.
2. No `===` / `!==` between a boolean literal and a number literal.
3. `+` takes exactly 2 numeric operands.
4. `reduce` needs a numeric literal as its initial value.
5. `in` haystacks contain only strings, ints or null.

Soft `==` and `!=` are excluded. **Guarantee:** a rule that passes `lint()` gives the same result in the
browser and in the backend. That is proven on every compat case that passes lint.

Case facts shape:

```json
{
  "reached": { "<module|signal>": ["<outcome>"] },
  "stages":  { "<module>": [1, 2] },
  "fields":  { "<module>": { "<field>": "<value>" } }
}
```
