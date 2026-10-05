"""Generic custom-module runtime (Phase 2 — configurator integration).

Copied from third_party/matrix-adapters (first-party glue written by F3; tested there on
the project's real data, 36 tests). Only the imports were changed:
  * gates.py   — uses the vendored app.vendor.json_logic (panzi-json-logic 1.0.1, MIT)
  * runtime.py — package-relative ``from . import forms, gates``
  * forms.py   — unchanged
manifest.schema.json is building-blocks/from-design/manifest.schema.json (shape of the
Workspace Configurator v5 manifest()), used to validate a release at publish time.
Persistence, HTTP and authorization live in services/module_runtime_service.py.
"""
