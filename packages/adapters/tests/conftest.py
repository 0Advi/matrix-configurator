import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PKG))
sys.path[:0] = [PKG, os.path.join(PKG, "examples"), os.path.join(ROOT, "packages", "manifest")]

from workspace_adapters.sdk import (Actor, AfterContext, ApproveContext, CaseSnapshot, OpenContext, OutcomeContext,  # noqa: E402
                                    ReadAPI, RuleContext, SubmitContext, SyncContext, freeze)

WORKSPACE = json.load(open(os.path.join(ROOT, "templates", "matrix-bd", "workspace.manifest.json"), encoding="utf-8"))
BD = next(m for m in WORKSPACE["modules"] if m["key"] == "bd")
ANA = Actor("u-ana", "Ana (executive)")
SAM = Actor("u-sam", "Sam (supervisor)")


def case(values=None, module="bd", release=3):
    return CaseSnapshot(id="c-1", module=module, release_version=release, subject_type="site", subject_id="s-1",
                        subject=freeze({"name": "Site 1", "city": "Pune"}), status="in_progress", current_stage="draft",
                        reached=("in_progress",), values=freeze(values or {}), created_by="u-ana")


def base(cls, module=BD, actor=ANA, values_on_case=None, **kw):
    ad = module.get("adapter") or {"key": "x", "version": "1.0.0", "hooks": []}
    return cls(adapter_key=ad["key"], adapter_version=ad["version"], config=freeze(ad.get("config", {})), module=freeze(module),
               case=case(values_on_case, module=module["key"]), actor=actor, read=ReadAPI(), locale="en-IN", currency="INR",
               now="2026-10-06T09:00:00+00:00", **kw)
