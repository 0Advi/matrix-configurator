"""Field definitions -> JSON Schema, rendered by rjsf and validated identically in the browser and backend.

For EVERY stage of every real manifest (3 v5 seeds + production flow):
  * the compiled schema is a valid draft-07 schema;
  * @rjsf/core 6.11.0 server-renders a widget for every field (third_party/rjsf-check);
  * ajv8 (rjsf's validator) and jsonschema 4.26.0 (backend) give the SAME verdict on a battery of
    valid and invalid submissions.
Needs: `npm ci` in third_party/rjsf-check and `pip install jsonschema==4.26.0` (skips otherwise).
"""
import os
import subprocess
import json
import unittest

from _util import THIRD_PARTY, all_manifests

import forms
import gates

RJSF = os.path.join(THIRD_PARTY, "rjsf-check")

try:
    import jsonschema  # noqa: F401
    HAVE_JSONSCHEMA = True
except ImportError:
    HAVE_JSONSCHEMA = False
HAVE_RJSF = os.path.isdir(os.path.join(RJSF, "node_modules", "@rjsf", "core"))


def valid_value(s):
    if "enum" in s:
        return s["enum"][0]
    t = s.get("type")
    if t == "boolean":
        return True
    if t == "number":
        return s.get("minimum", 1)
    if s.get("format") == "date":
        return "2026-10-04"
    if s.get("format") == "data-url":
        return "data:application/pdf;base64,JVBERi0xLjQK"
    if "pattern" in s:
        return "https://example.com/doc"
    return "sample"


def samples_for(schema):
    props = schema["properties"]
    good = {k: valid_value(s) for k, s in props.items()}
    out = [good, {}]
    for k, s in props.items():
        bad_type = dict(good, **{k: "not-a-number" if s.get("type") in ("number", "boolean") else 12345})
        out.append(bad_type)
        if "maximum" in s:
            out.append(dict(good, **{k: s["maximum"] + 1}))
        if "minimum" in s:
            out.append(dict(good, **{k: s["minimum"] - 1}))
        if "enum" in s:
            out.append(dict(good, **{k: "definitely-not-an-option"}))
        if s.get("format") == "date":
            out.append(dict(good, **{k: "04/10/2026"}))
    out.append(dict(good, unexpected_field=1))
    return out


def all_stage_forms():
    for label, manifest in all_manifests():
        for m in manifest["modules"]:
            for st in m["stages"]:
                if st["fields"]:
                    yield f"{label}/{m['key']}/{st['order']}", st, forms.stage_form(st)


class StageForms(unittest.TestCase):
    def test_compiles_every_real_stage(self):
        n_stages = n_fields = 0
        unparsed = []
        for sid, st, f in all_stage_forms():
            n_stages += 1
            n_fields += len(st["fields"])
            self.assertEqual(sorted(f["schema"]["properties"]), sorted(x["key"] for x in st["fields"]), sid)
            self.assertEqual(f["schema"].get("required", []), [x["key"] for x in st["fields"] if x["required"]])
            unparsed += [(sid, u["field"], u["hint"]) for u in f["unparsed"]]
        print(f"\n  compiled {n_stages} stages / {n_fields} fields; {len(unparsed)} free-text hints kept as help text:")
        for u in sorted({u[2] for u in unparsed}):
            print("    -", u)
        self.assertGreaterEqual(n_stages, 60)

    def test_hint_parsing(self):
        fs = forms.field_schema
        self.assertEqual(fs({"key": "a", "kind": "number", "validation": "min 120 · max 40000"})["schema"]["maximum"], 40000)
        self.assertEqual(fs({"key": "a", "kind": "number", "validation": "0–100"})["schema"]["minimum"], 0)
        self.assertEqual(fs({"key": "a", "kind": "choice", "validation": "yes · no · n/a"})["schema"]["enum"], ["yes", "no", "n/a"])
        f = fs({"key": "a", "kind": "file", "validation": "pdf · max 20MB"})
        self.assertEqual(f["ui"]["ui:options"], {"accept": ".pdf", "maxSize": "20MB"})
        self.assertNotIn("maximum", f["schema"])
        self.assertEqual(fs({"key": "a", "kind": "text", "validation": "^https?://"})["schema"]["pattern"], "^https?://")
        self.assertFalse(fs({"key": "a", "kind": "text", "validation": "required when the verdict is negative"})["parsed"])

    def test_rollup_from_real_legal_ddr_stage(self):
        legal = next(m for lbl, man in all_manifests() if lbl == "matrix-bd-flow" for m in man["modules"] if m["key"] == "legal")
        ddr = legal["stages"][0]
        f = forms.stage_form(ddr)
        self.assertGreaterEqual(len(f["rollupFields"]), 5)
        answers = {k: "yes" for k in f["rollupFields"]}
        self.assertEqual(gates.rollup_verdict(legal["rollup"], forms.rollup_checks(f, answers)), "approved")
        answers[f["rollupFields"][0]] = "no"
        self.assertEqual(gates.rollup_verdict(legal["rollup"], forms.rollup_checks(f, answers)), "rejected")
        answers[f["rollupFields"][0]] = None
        self.assertEqual(gates.rollup_verdict(legal["rollup"], forms.rollup_checks(f, answers)), "pending")

    @unittest.skipUnless(HAVE_JSONSCHEMA, "pip install jsonschema==4.26.0")
    def test_schemas_are_valid_draft7(self):
        for sid, _, f in all_stage_forms():
            jsonschema.Draft7Validator.check_schema(f["schema"])

    @unittest.skipUnless(HAVE_JSONSCHEMA and HAVE_RJSF, "needs jsonschema==4.26.0 and `npm ci` in third_party/rjsf-check")
    def test_rjsf_renders_and_ajv_agrees_with_backend(self):
        batch = []
        for sid, _, f in all_stage_forms():
            batch.append({"id": sid, "schema": f["schema"], "uiSchema": f["uiSchema"], "samples": samples_for(f["schema"])})
        proc = subprocess.run(["node", os.path.join(RJSF, "render-check.mjs")], input=json.dumps(batch),
                              capture_output=True, text=True, timeout=300, cwd=RJSF)
        self.assertEqual(proc.returncode, 0, proc.stderr[:3000])
        res = {r["id"]: r for r in json.loads(proc.stdout)}
        n_samples = agree = 0
        mismatches = []
        for item in batch:
            r = res[item["id"]]
            self.assertEqual(r["missing"], [], f"{item['id']}: fields not rendered")
            for sample, js_ok, js_err in zip(item["samples"], r["verdicts"], r["errors"]):
                py_err = forms.validate_submission(item["schema"], sample)
                n_samples += 1
                if js_ok == (not py_err):
                    agree += 1
                else:
                    mismatches.append((item["id"], sample, js_err, py_err))
        print(f"\n  rjsf rendered {len(batch)} stage forms; {n_samples} submissions validated, "
              f"ajv8 == jsonschema on {agree}")
        self.assertEqual(mismatches, [])
        self.assertTrue(all(res[b["id"]]["verdicts"][0] for b in batch), "the generated valid sample must pass")
        self.assertTrue(any(not res[b["id"]]["verdicts"][1] for b in batch), "empty submissions must fail somewhere")


if __name__ == "__main__":
    unittest.main(verbosity=2)
