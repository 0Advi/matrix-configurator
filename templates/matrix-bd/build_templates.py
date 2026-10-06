#!/usr/bin/env python3
"""Build the Matrix-bd module templates (Task 4) from the extracted production flow.

Input : building-blocks/from-matrix-bd/matrix-bd-flow.json (Matrix-bd @ 3d4f277, G2-corrected flow model)
Output: templates/matrix-bd/
          <module>.template.json        one portable template per former built-in
          workspace.manifest.json       all templates composed into one valid workspace-manifest/1
          adapters.registry.json        the adapter hooks the templates declare (Task 5 implements them)

Run   : python templates/matrix-bd/build_templates.py      (needs packages/manifest on the path)

The stage/actor structure below is modelled from the flow's ``x-matrix.actors`` (who really does what),
NOT from the v5 ``approvers`` lists, which only name one tier per stage. Fields are taken from the flow
by key and converted to typed validation; every flow field lands exactly once (stage form, approval form
or subject field) — tests/test_templates.py checks this.

These templates are CUSTOMER content (Matrix-bd's flow), not product content: they ship in a private
customer repo, never in the product's templates/ (docs/independence/AUDIT.md §8.3).
"""
from __future__ import annotations

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "packages", "manifest"))

from workspace_manifest import validate  # noqa: E402
from workspace_manifest.from_v5 import convert_field, default_outcomes  # noqa: E402

FLOW = json.load(open(os.path.join(ROOT, "building-blocks", "from-matrix-bd", "matrix-bd-flow.json"), encoding="utf-8"))
FLOW_MODULES = {m["key"]: m for m in FLOW["modules"]}
TEMPLATE_VERSION = "1.0.0"
SOURCE = {"repo": "Matrix-bd", "commit": FLOW["provenance"]["sha"], "extracted_from": "building-blocks/from-matrix-bd/matrix-bd-flow.json"}

# Keys renamed so the template carries no third-party brand (labels say which chains in the customer's config).
RENAMED = {"nearest_starbucks_m": "nearest_competitor_a_m", "nearest_twc_m": "nearest_competitor_b_m", "site_name": "name"}
RENAMED_LABELS = {"nearest_competitor_a_m": "Nearest competitor A (m)", "nearest_competitor_b_m": "Nearest competitor B (m)", "name": "Site name"}
# Flow fields that become SUBJECT fields (captured once when the site is created, shared by every module).
SUBJECT_FIELDS = ["site_name", "city", "visit_date", "model", "spoc_name", "google_maps_url", "area_sqft"]

INR = {"currency": "INR"}
YES_NO_NA = {"yes": "positive", "no": "negative", "n/a": "neutral", "positive": "positive", "negative": "negative",
             "approved": "positive", "rejected": "negative", "done": "positive", "pending": "neutral",
             "ordered": "neutral", "received": "positive", "ready": "neutral", "active": "positive"}


def flow_field(module: str, order: int, key: str) -> dict:
    st = next(s for s in FLOW_MODULES[module]["stages"] if s["order"] == order)
    return next(f for f in st["fields"] if f["key"] == key)


def field(module: str, order: int, key: str, **override) -> dict:
    """Flow field → typed manifest field, with Matrix-bd free-text hints turned into typed validation."""
    src = flow_field(module, order, key)
    notes: list = []
    f = convert_field(src, notes)
    hint = src.get("validation") or ""
    f.pop("help", None)
    new_key = RENAMED.get(key, key)
    f["key"] = new_key
    if new_key in RENAMED_LABELS:
        f["label"] = RENAMED_LABELS[new_key]
    if src["kind"] == "number" and "₹" in hint:
        f["type"] = "money"
        f["validation"] = dict(f.get("validation") or {}, min=0, **INR)
    if f["type"] == "choice":
        for o in f.get("options", []):
            if o["label"] in YES_NO_NA:
                o["score"] = YES_NO_NA[o["label"]]
    if "required when" in hint or "used only when" in hint or "set by the supervisor" in hint:
        f["help"] = hint.replace("Supabase Storage", "file storage")
    if key == "rejection_reasons":
        f["type"] = "long_text"
    if key in ("staggered_escalation",):
        f["type"], f["help"] = "long_text", "Up to 5 rows of {year, percent}; checked by the template adapter (validateBusinessRule)."
        f.pop("validation", None)
    if key == "ca_code":
        f["help"] = "Unique per workspace (case-insensitive); becomes the site's display code."
        f.pop("validation", None)
    if key == "pex_documents":
        f["validation"] = {"accept": ["image/png", "image/jpeg", "application/pdf"], "max_size_mb": 5}
    if key in ("qa_before_report", "qa_after_report"):
        f["validation"] = {"accept": ["application/pdf"]}
    if key == "rent_terms":
        f["type"], f["help"] = "long_text", "Rent-terms group (rent type and its conditional amounts); checked by the template adapter."
    if key == "rent_start_date":
        f["help"] = "The only field the site's creator may edit in this loop."
    f.update(override)
    return f


def fields(module: str, order: int, *keys: str, **overrides) -> list:
    return [field(module, order, k, **overrides.get(k, {})) for k in keys]


def approval(role: str, actions=("approve", "send_back"), fields_=None, module=None, label=None) -> dict:
    a = {"role": role, "actions": list(actions)}
    if module:
        a["module"] = module
    if label:
        a["label"] = label
    if fields_:
        a["fields"] = fields_
    return a


def stage(key, name, submit_roles, outcome, *, fields_=(), approvals=(), restricted_to=None, restrict_roles=None,
          submit_module=None, gate=None, send_back_to=None, description=None) -> dict:
    s = {"key": key, "name": name, "submit": {"roles": list(submit_roles)}, "outcome": outcome}
    if restricted_to:
        s["submit"]["restricted_to"] = restricted_to
    if restrict_roles:
        s["submit"]["restrict_roles"] = list(restrict_roles)
    if submit_module:
        s["submit"]["module"] = submit_module
    if description:
        s["description"] = description
    if approvals:
        s["approvals"] = list(approvals)
    if fields_:
        s["fields"] = list(fields_)
    if gate:
        s["gate"] = gate
    if send_back_to:
        s["send_back_to"] = list(send_back_to)
    return s


def gate(*conds, refusal):
    return {"match": "all", "conditions": [{"source": s, "outcome": o} for s, o in conds], "refusal_message": refusal}


def hook(name, purpose, why_not_generic, source, generic_candidate=None):
    h = {"hook": name, "purpose": purpose, "why_not_generic": why_not_generic, "matrix_bd_source": source}
    if generic_candidate:
        h["generic_candidate"] = generic_candidate
    return h


EXEC_SUP = ["executive", "supervisor"]

# ───────────────────────────────────────────────────────────────────────────── module definitions ──
DEFS = {}

DEFS["bd"] = dict(  # adapter: packages/adapters/examples/matrix_bd_bd (Task 5 example)
    flow="bd", name="BD — site identification", icon="map-pin", members=EXEC_SUP, delegation=True,
    separation_of_duties=False,
    entry_gate=None,
    stages=[
        stage("draft", "Draft & shortlist", EXEC_SUP, "in_progress",
              fields_=fields("bd", 1, "rent_type", "expected_rent", "staggered_escalation"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"), label="Shortlist",
                                  fields_=fields("bd", 2, "rejection_reasons"))],
              description="An executive or supervisor captures the site; a supervisor shortlists, rejects or archives it."),
        stage("details", "Details review", EXEC_SUP, "approved",
              fields_=fields("bd", 3, "score", "est_sales", "nearest_starbucks_m", "nearest_twc_m", "carpet_area_sqft",
                             "cam_charges", "rent", "security_deposit", "capex", "brokerage", "lock_in_months",
                             "tenure_months", "rent_free_days"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"),
                                  fields_=fields("bd", 3, "expected_loi_days"))]),
        stage("loi", "LOI", EXEC_SUP, "done",
              fields_=fields("bd", 4, "loi_document"),
              approvals=[approval("supervisor", ("approve", "send_back"), label="Send to Legal",
                                  fields_=fields("bd", 4, "loi_send_back_comments"))],
              send_back_to=["loi"]),
    ],
    exit={"on_complete": "done", "on_reject": "rejected"},
    adapter_hooks=[
        hook("beforeSubmit", "Normalise rent terms: switching away from 'staggered' clears the schedule; the schedule is stored as canonical JSON sorted by year.",
             "Normalising one field depending on another is not expressible.", "backend/app/services/bd_service.py _apply_staggered_escalation",
             generic_candidate="field.visible_if (hidden fields are cleared on submit)"),
        hook("validateBusinessRule", "Rent terms: which amounts are required depends on rent_type (fixed / revshare / mg_revshare / staggered); the staggered schedule has at most 5 {year, percent} rows.",
             "Conditional requirements and repeating rows are not expressible in workspace-manifest/1.", "rent-terms.json; backend/app/domain/schemas/site.py CreateDraftRequest",
             generic_candidate="field.required_if + a 'table' field type"),
        hook("afterApprove", "On details approval, turn expected_loi_days into an LOI deadline (emits event bd.loi_deadline_set {due_at}).",
             "Per-case deadlines computed from a field are not expressible (stage.sla_hours is static).", "backend/app/services/bd_service.py approve",
             generic_candidate="stage.sla_from_field"),
    ],
    generic=["capture → shortlist → details → LOI as stages with explicit submit roles and supervisor tiers",
             "reject (shortlist / details) ends the case with 'rejected'",
             "LOI send-back = rework inside the LOI stage (send_back_to: [loi])",
             "supervisors may shortlist their own draft: separation_of_duties off (Matrix-bd exempts supervisors and admins)",
             "'BD done' (Legal can start) = LOI approved, i.e. the supervisor's 'send to Legal' (fix for D18)",
             "site name, city, visit date, model, SPOC, maps link and area are SUBJECT fields shared by every module"],
    matrix_specific=["archive with a revivable 'archived_from_status' (no generic withdraw/revive; mapped to reject)",
                     "draft and shortlist are one stage here; 'submitted' is no longer separately reached by BD",
                     "rent-terms conditional fields and the staggered schedule (adapter)",
                     "LOI deadline from expected_loi_days (adapter)"],
)

DEFS["legal"] = dict(
    flow="legal", name="Legal & Compliance", icon="scale", members=EXEC_SUP, delegation=True,
    entry_gate=gate(("bd", "done"), refusal="Legal & Compliance is locked: waiting for BD to send the signed LOI to Legal."),
    stages=[
        stage("ddr", "Due diligence report (DDR)", EXEC_SUP, "approved", restricted_to="assignee", restrict_roles=["executive"],
              fields_=fields("legal", 1, "dd_title_doc", "dd_sanctioned_plan", "dd_oc_cc", "dd_commercial_use",
                             "dd_property_tax", "dd_electricity", "dd_fire_noc", "dd_other_1", "dd_other_2"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"), label="Final verdict",
                                  fields_=fields("legal", 1, "dd_final_verdict", "dd_rejection_reason",
                                                 dd_final_verdict={"required": True}))]),
        stage("agreement", "Agreement", ["supervisor"], "submitted", fields_=fields("legal", 2, "agr_signed", "agr_registered", "agr_document")),
        stage("licensing", "Licensing", EXEC_SUP, "done", restricted_to="assignee", restrict_roles=["executive"],
              fields_=fields("legal", 3, "lic_fssai", "lic_health_trade", "lic_shops_estab", "lic_fire_noc", "lic_storage"),
              approvals=[approval("supervisor", ("approve", "send_back"))]),
    ],
    exit={"on_complete": "done", "on_reject": "rejected"},
    adapter_hooks=[
        hook("validateBusinessRule", "A negative DDR verdict requires a rejection reason and can only be rejected; approving requires a positive verdict. Licensing completes only when every item is yes or n/a.",
             "Cross-field rules between an approval field and the chosen action are not expressible.", "backend/app/services/legal_service.py",
             generic_candidate="action.requires (field condition per action) + field.required_if"),
        hook("syncExternalState", "Change-request loop: an approved BD change request that clears the last failing DD item reopens a rejected Legal case (consumes event change_request.approved; asks the runtime to reopen).",
             "Reopening a closed case is not a runtime action today.", "backend/app/services/change_request_service.py _maybe_recover_dd_verdict",
             generic_candidate="a 'reopen' action + grant"),
    ],
    generic=["entry gate on BD 'done'", "executives act only on cases assigned to them (restricted_to: assignee for executives); supervisors always",
             "DDR verdict is an approval field; a negative verdict rejects the case", "reaching 'approved' at the DDR opens Design (with Finance)"],
    matrix_specific=["verdict ⇄ action consistency and licensing completeness (adapter)", "change-request revival of a rejected DDR (adapter)",
                     "Indian licence names (FSSAI, shops & establishments) are the customer's field labels"],
)

DEFS["finance_ca"] = dict(
    flow="finance_ca", name="CA / Commercial code", icon="landmark", members=EXEC_SUP, delegation=False,
    entry_gate=gate(("bd", "done"), refusal="Finance details can only be entered after the LOI is uploaded."),
    stages=[
        stage("ca_kyc", "CA code & KYC", EXEC_SUP, "approved", restricted_to="subject_creator", restrict_roles=["executive"],
              fields_=fields("finance_ca", 1, "kyc_verified", "ca_code", "finance_amount"),
              approvals=[approval("supervisor", ("approve", "send_back")), approval("business_admin", ("approve", "send_back"))],
              description="The site owner (executive) or a supervisor enters CA code and KYC; supervisor then business admin approve. Either tier's 'reject' returns it for rework (no terminal reject)."),
    ],
    exit={"on_complete": "approved"},
    adapter_hooks=[
        hook("validateBusinessRule", "ca_code is unique per workspace, case-insensitive.", "Uniqueness across cases is not expressible.",
             "backend/app/services/finance_service.py", generic_candidate="validation.unique: 'workspace'"),
        hook("afterApprove", "On the final approval, the CA code becomes the site's display code (emits event subject.code_assigned {code}).",
             "Writing a subject attribute on completion is not expressible.", "backend/app/services/finance_service.py",
             generic_candidate="exit.set_subject_fields"),
    ],
    generic=["three real states (owner entry → supervisor → admin) become ONE stage with a two-tier approval chain",
             "a tier's 'reject' in Matrix-bd only unlocks the fields again → modelled as send_back, not reject",
             "only the site's creator among executives may enter it (subject_creator)"],
    matrix_specific=["unique CA code; CA code becomes the site code (adapter)"],
)

DEFS["design"] = dict(
    flow="design", name="Design / Technical", icon="ruler", members=EXEC_SUP, delegation=True, separation_of_duties=False,
    entry_gate=gate(("legal", "approved"), ("finance_ca", "approved"), refusal="Design is locked: waiting for a positive DDR and Finance approval."),
    stages=[
        stage("recce", "Recce", EXEC_SUP, "submitted", fields_=fields("design", 1, "recce_pack"),
              approvals=[approval("supervisor", ("approve", "send_back"), fields_=fields("design", 1, "recce_supervisor_comments"))]),
        stage("drawing_2d", "2D drawing", EXEC_SUP, "in_progress", fields_=fields("design", 2, "drawing_2d"),
              approvals=[approval("supervisor", ("approve", "send_back")),
                         approval("business_admin", ("approve", "send_back"), fields_=fields("design", 2, "drawing_2d_admin_comments"))]),
        stage("drawing_3d", "3D render", EXEC_SUP, "in_progress", fields_=fields("design", 3, "drawing_3d"),
              approvals=[approval("supervisor", ("approve", "send_back")),
                         approval("business_admin", ("approve", "send_back"), fields_=fields("design", 3, "drawing_3d_admin_comments"))]),
        stage("gfc", "GFC approval", ["supervisor"], "approved",
              approvals=[approval("business_admin", ("approve", "send_back"), label="GFC decision", fields_=fields("design", 4, "gfc_comments"))],
              send_back_to=["drawing_3d"]),
    ],
    exit={"on_complete": "approved"},
    adapter_hooks=[],
    generic=["entry gate: Legal 'approved' AND Finance 'approved'", "upload → supervisor → (admin) review per deliverable",
             "GFC rejection returns to the 3D stage (send_back_to)", "a supervisor's own upload needs no second person (separation_of_duties off)",
             "GFC approval opens Project Excellence and Project (their gates)"],
    matrix_specific=["undo of supervisor/admin 2D/3D decisions (reversible_actions) — not carried over; a send_back is the generic correction"],
)

DEFS["project_excellence"] = dict(
    flow="pex", name="Project Excellence", icon="gauge", members=EXEC_SUP, delegation=True,
    entry_gate=gate(("design", "approved"), refusal="Project Excellence is locked until Design GFC is approved."),
    stages=[
        stage("gfc_budget", "GFC budget (11 heads)", EXEC_SUP, "approved",
              fields_=fields("pex", 1, "pex_professional_fees", "pex_hvac", "pex_furniture_light_planters", "pex_civil_interiors",
                             "pex_kitchen_equipment", "pex_branding", "pex_crockery_small_equipments", "pex_utilities", "pex_licencing",
                             "pex_bd_cost", "pex_misc", "pex_total_indoor_area_sqft", "pex_total_area_sqft", "pex_covers", "pex_documents"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"), fields_=fields("pex", 2, "pex_supervisor_comments")),
                         approval("business_admin", ("approve", "reject", "send_back"),
                                  fields_=fields("pex", 3, "pex_initialization_date", "pex_admin_comments", pex_initialization_date={"required": True}))]),
        stage("quality_audit_reports", "Quality-audit reports", EXEC_SUP, "done", restricted_to="assignee", restrict_roles=["executive"],
              fields_=fields("pex", 4, "qa_before_report", "qa_after_report")),
    ],
    exit={"on_complete": "done", "on_reject": "rejected"},
    adapter_hooks=[
        hook("afterApprove", "On the admin's budget approval, propose the Project initialization date (emits event project.initialization_proposed {date, proposed_by}).",
             "One module seeding another module's step is cross-module behaviour; it must travel as an event.", "backend/app/services/project_service.py seed_initialization_from_pe"),
    ],
    generic=["11 budget heads as money fields; supervisor then admin approval", "initialization date is an approval field the admin must fill to approve",
             "QA reports by an assigned executive or a supervisor"],
    matrix_specific=["seeding Project's initialization date (adapter → event)"],
)

DEFS["project"] = dict(
    flow="project", name="Project execution", icon="hammer", members=EXEC_SUP, delegation=True,
    entry_gate=gate(("design", "approved"), refusal="Project is locked until Design receives final GFC approval."),
    stages=[
        stage("initialization", "Initialization date", ["business_admin", "supervisor"], "allocated",
              fields_=fields("project", 1, "initialization_date"),
              approvals=[approval("executive", ("approve", "send_back"), label="Accept date")],
              description="Proposed by the admin (from the PE approval) or a supervisor; the executive accepts or sends it back."),
        stage("expected_completion", "Expected completion", EXEC_SUP, "submitted", fields_=fields("project", 2, "expected_completion_date"),
              approvals=[approval("supervisor", ("approve", "send_back"))]),
        stage("mid_project_visit", "Mid-project visit", ["supervisor"], "in_progress", fields_=fields("project", 3, "mid_project_visit_date")),
        stage("quality_audit", "Quality audit", EXEC_SUP, "approved", fields_=fields("project", 4, "inspection_date"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"), fields_=fields("project", 4, "quality_audit_comments")),
                         approval("supervisor", ("approve", "send_back"), module="project_excellence", label="Project Excellence sign-off")]),
        stage("push_to_nso", "Push to NSO", ["supervisor"], "done"),
    ],
    exit={"on_complete": "done", "on_reject": "rejected"},
    adapter_hooks=[
        hook("syncExternalState", "Consume project.initialization_proposed and submit the initialization stage with that date on behalf of the proposing admin (runtime command, attributed to them).",
             "Cross-module seeding (see Project Excellence).", "backend/app/services/project_service.py seed_initialization_from_pe",
             generic_candidate="field.prefill_from + auto-submit"),
    ],
    generic=["initialization → expected completion → mid visit → quality audit → push to NSO",
             "quality audit's second tier is the PROJECT EXCELLENCE supervisor (approval.module) — no hidden cross-module role check",
             "'project done' opens NSO stage 3 (NSO's stage gate)"],
    matrix_specific=["legacy business-admin confirmation route for the quality audit (not carried over)", "initialization seeded from PE (adapter)"],
)

DEFS["nso"] = dict(
    flow="nso", name="NSO", icon="store", members=["supervisor"], delegation=False,
    entry_gate=gate(("finance_ca", "approved"), refusal="NSO Stage 1 is locked until Finance / CA is approved."),
    stages=[
        stage("property_communication", "Property & communication", ["supervisor"], "submitted",
              fields_=fields("nso", 1, "property_details", "communication_floated")),
        stage("licensing", "Licensing (from Legal)", ["supervisor"], "in_progress",
              fields_=fields("nso", 2, "nso_fssai", "nso_health_trade", "nso_shops_estab", "nso_fire_noc", "nso_storage_licence")),
        stage("launch_readiness", "Launch readiness", ["supervisor"], "in_progress",
              fields_=fields("nso", 3, "dry_stock_order", "online_delivery", "handover_checklist_signed", "launch_date", "launch_ready"),
              gate=gate(("project", "done"), refusal="Launch readiness opens when Project pushes the site to NSO.")),
        stage("final_approval", "Final approval", ["supervisor"], "done", fields_=fields("nso", 4, "final_signoff_1", "final_signoff_2")),
    ],
    exit={"on_complete": "done"},
    adapter_hooks=[
        hook("syncExternalState", "Prefill the licensing stage from Legal's licensing values (lic_* → nso_*), read through the runtime's case-read API, never from Legal's tables.",
             "Copying another module's field values is not expressible.", "backend/app/services/nso_service.py refresh from Legal",
             generic_candidate="field.prefill_from {source, stage, field}"),
    ],
    generic=["supervisor-only module (members: [supervisor])", "stage 3 waits on Project 'done' (stage gate)", "final approval completes NSO → opens Launch approval"],
    matrix_specific=["licensing refreshed from Legal (adapter)"],
)

DEFS["launch_approval"] = dict(
    flow="launch_approval", name="Launch approval", icon="rocket", members=EXEC_SUP, delegation=False,
    entry_gate=gate(("nso", "done"), refusal="Launch approval is locked: waiting for NSO final approval."),
    stages=[
        stage("admin_review", "Admin review", ["business_admin"], "submitted", fields_=fields("launch_approval", 1, "rent_terms", "admin_review_comment")),
        stage("creator_review", "Creator review", EXEC_SUP, "submitted", restricted_to="subject_creator",
              fields_=fields("launch_approval", 2, "exec_verdict", "exec_comment", "rent_start_date")),
        stage("supervisor_review", "Supervisor review", ["supervisor"], "submitted", fields_=fields("launch_approval", 3, "supervisor_verdict", "supervisor_comment")),
        stage("admin_final", "Admin final confirm", ["business_admin"], "approved", fields_=fields("launch_approval", 4, "admin_final_comment")),
        stage("launch", "Launch", ["business_admin"], "done"),
    ],
    exit={"on_complete": "done"},
    adapter_hooks=[
        hook("syncExternalState", "Open the launch case automatically when NSO completes (consumes case.completed for nso; runtime 'open case' command).",
             "Auto-opening a module when its gate opens is not a manifest option.", "backend/app/services/nso_service.py final approval → launch_approvals",
             generic_candidate="module.auto_open: true"),
        hook("validateBusinessRule", "Rent-terms group is consistent (same rule as BD).", "Conditional/grouped fields (see BD).", "rent-terms.json",
             generic_candidate="field.required_if + 'table' field type"),
        hook("afterSubmit", "admin_final: emit subject.rent_terms_committed with the agreed terms; launch: emit subject.launched.",
             "Matrix-bd commits the staged terms into the site; here it becomes an event the subject owner applies — never a direct write into BD's data.",
             "backend/app/services/launch_service.py _commit_rent_to_canonical, launch"),
    ],
    generic=["admin → creator → supervisor → admin loop as four ordered stages", "creator review bound to the SITE's creator (subject_creator)",
             "verdicts are data; the admin's final confirmation decides", "launch completes the module → opens Financial closure"],
    matrix_specific=["auto-open on NSO completion; rent terms committed back onto the site (adapter → events)"],
)

DEFS["financial_closure"] = dict(
    flow="financial_closure", name="Financial closure", icon="receipt", members=["supervisor"], delegation=False,
    entry_gate=gate(("launch_approval", "done"), refusal="Financial closure opens only after the site is launched."),
    stages=[
        stage("send_for_closure", "Send for closure", ["business_admin"], "allocated"),
        stage("actuals", "Actuals (11 heads)", EXEC_SUP, "submitted", submit_module="project",
              fields_=fields("financial_closure", 2, "fc_professional_fees", "fc_hvac", "fc_furniture_light_planters", "fc_civil_interiors",
                             "fc_kitchen_equipment", "fc_branding", "fc_crockery_small_equipments", "fc_utilities", "fc_licencing",
                             "fc_bd_cost", "fc_misc"),
              approvals=[approval("supervisor", ("approve", "reject", "send_back"), module="project")]),
        stage("sign_off", "Closure sign-off", ["business_admin"], "done"),
    ],
    exit={"on_complete": "done", "on_reject": "rejected"},
    adapter_hooks=[
        hook("afterSubmit", "sign_off: emit subject.archived (the site moves to the admin's history).", "Subject lifecycle changes are events, not module behaviour.",
             "backend/app/services/financial_closure_service.py"),
    ],
    generic=["staffed by the PROJECT team: submit and review roles borrowed from module 'project' (submit.module / approval.module)",
             "11 actual-cost heads as money fields", "admin sends for closure and signs off"],
    matrix_specific=["has no members of its own in Matrix-bd (has_membership=false) — 'members: [supervisor]' is only the module's own placeholder role",
                     "site archived on closure (adapter → event)"],
)

ORDER = ["bd", "legal", "finance_ca", "design", "project_excellence", "project", "nso", "launch_approval", "financial_closure"]

ROLES = [
    {"key": "workspace_admin", "name": "Workspace admin", "scope": "workspace", "rank": 100},
    {"key": "business_admin", "name": "Business admin", "scope": "workspace", "rank": 90},
    {"key": "supervisor", "name": "Supervisor", "scope": "module", "rank": 20},
    {"key": "executive", "name": "Executive", "scope": "module", "rank": 10},
    {"key": "observer", "name": "Observer", "scope": "workspace", "rank": 0, "read_only": True},
]
GRANTS = [
    {"action": "edit_draft", "roles": ["workspace_admin"]}, {"action": "publish_release", "roles": ["workspace_admin"]},
    {"action": "migrate_cases", "roles": ["workspace_admin"]}, {"action": "manage_members", "roles": ["business_admin"]},
    {"action": "manage_views", "roles": ["business_admin"]}, {"action": "assign_cases", "roles": ["supervisor", "business_admin"]},
    {"action": "view_all_cases", "roles": ["business_admin", "observer"]}, {"action": "override_step", "roles": ["business_admin"]},
    {"action": "view_audit", "roles": ["business_admin", "observer"]},
]


def subject():
    return {"key": "site", "label": "Site", "plural": "Sites", "fields": [field("bd", 1, k) for k in SUBJECT_FIELDS]}


def build_module(key: str) -> dict:
    d = DEFS[key]
    m = {"key": key, "name": d["name"], "icon": d["icon"], "subject": "site", "members": list(d["members"]),
         "delegation": d["delegation"]}
    if "separation_of_duties" in d:
        m["separation_of_duties"] = d["separation_of_duties"]
    m["entry_gate"] = d["entry_gate"]
    m["stages"] = copy.deepcopy(d["stages"])
    m["exit"] = d["exit"]
    if d["adapter_hooks"]:
        m["adapter"] = {"key": f"matrix_bd.{key}", "version": TEMPLATE_VERSION, "hooks": sorted({h["hook"] for h in d["adapter_hooks"]})}
    if key == "bd":  # settings the example adapter reads instead of hard-coding field/stage keys
        m["adapter"]["config"] = {"rent_stage": "draft", "deadline_stage": "details", "deadline_field": "expected_loi_days",
                                  "schedule_max_rows": 5}
    m["template"] = {"key": f"matrix-bd/{key}", "version": TEMPLATE_VERSION}
    return m


def summarize(m: dict) -> dict:
    return {
        "stages": [{"key": s["key"], "name": s["name"], "submit": s["submit"],
                    "approvals": [{k: a[k] for k in ("role", "module", "actions", "label") if k in a} for a in s.get("approvals", [])],
                    "fields": [f["key"] for f in s.get("fields", [])],
                    "approval_fields": [f["key"] for a in s.get("approvals", []) for f in a.get("fields", [])],
                    "outcome": s["outcome"], **({"gate": s["gate"]} if "gate" in s else {}),
                    **({"send_back_to": s["send_back_to"]} if "send_back_to" in s else {})} for s in m["stages"]],
        "entry_gate": m["entry_gate"],
        "exit_outcomes": m["exit"],
        "approval_tiers": sorted({a["role"] + (f"@{a['module']}" if a.get("module") else "") for s in m["stages"] for a in s.get("approvals", [])}),
    }


def requires(m: dict) -> dict:
    deps = {c["source"] for g in [m.get("entry_gate")] + [s.get("gate") for s in m["stages"]] if g for c in g["conditions"]}
    borrowed = {x for s in m["stages"] for x in [s["submit"].get("module")] + [a.get("module") for a in s.get("approvals", [])] if x}
    return {"subject": "site", "modules": sorted(deps | borrowed),
            "roles": sorted({r for s in m["stages"] for r in s["submit"]["roles"]} | {a["role"] for s in m["stages"] for a in s.get("approvals", [])} | set(m["members"])),
            "outcomes": sorted({s["outcome"] for s in m["stages"]} | set(m["exit"].values()))}


def main() -> int:
    modules = [build_module(k) for k in ORDER]
    manifest = {"format": "workspace-manifest/1",
                "workspace": {"key": "retail-expansion", "name": "Retail expansion (Matrix-bd flow)", "locale": "en-IN", "currency": "INR",
                              "description": "Matrix-bd's nine former built-in modules, rebuilt from templates/matrix-bd."},
                "subjects": [subject()], "roles": ROLES, "outcomes": default_outcomes(), "signals": [], "modules": modules, "permissions": GRANTS}
    registry = {f"matrix_bd.{k}": {"versions": [TEMPLATE_VERSION], "hooks": sorted({h["hook"] for h in DEFS[k]["adapter_hooks"]}),
                                   "provided_by": "customer adapter package (Task 5 interface)"} for k in ORDER if DEFS[k]["adapter_hooks"]}
    rep = validate(manifest, adapters=registry)
    if not rep["ok"]:
        print(json.dumps(rep["findings"], indent=1))
        return 1
    for m in modules:
        k = m["key"]
        tpl = {"template": {"key": f"matrix-bd/{k}", "version": TEMPLATE_VERSION, "title": m["name"], "source": dict(SOURCE, module=DEFS[k]["flow"]),
                            "visibility": "customer-private"},
               "requires": requires(m),
               "module": m,
               "summary": summarize(m),
               "adapter_hooks": DEFS[k]["adapter_hooks"],
               "behaviour": {"generic": DEFS[k]["generic"], "matrix_bd_specific": DEFS[k]["matrix_specific"]},
               "renamed_fields": {o: n for o, n in RENAMED.items() if any(f["key"] == n for s in m["stages"] for f in s.get("fields", []))}}
        json.dump(tpl, open(os.path.join(HERE, f"{k}.template.json"), "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    json.dump(manifest, open(os.path.join(HERE, "workspace.manifest.json"), "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    json.dump(registry, open(os.path.join(HERE, "adapters.registry.json"), "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"{len(modules)} templates written; composed workspace OK ({rep['warnings']} warning(s))")
    for f in rep["findings"]:
        print(f"  {f['severity']} {f['code']}: {f['message']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
