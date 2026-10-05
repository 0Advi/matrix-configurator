#!/usr/bin/env node
// Builds from-matrix-bd/matrix-bd-flow.json: the CURRENT production Blue Tokai
// retail-expansion flow (Matrix-bd @ origin/main) expressed as configurator data.
//
// Shape: every module is a v5 *manifest* module (manifest.schema.json $defs.moduleManifest)
// plus an "x-matrix" annotation object (real state columns, actors, routes, stage-level
// gates, send-back loops, sources). flow-adapter.mjs strips the annotations to produce a
// v5 manifest or a v5 workspace document the configurator can load.
//
// The facts below are HAND-CURATED from source at the pinned SHA (each module/stage cites
// its files). The comparison block against the v5 `bluetokai` seed is COMPUTED.
//
//   node scripts/build-matrix-bd-flow.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHA = '3d4f277beb22c5be02c2abacea61b6afaee7cdeb';
const B = ['supervisor', 'executive'], S = ['supervisor'];

// ---------------------------------------------------------------- helpers
const F = (key, label, kind, required = false, validation = null, affects = false, x) =>
  Object.assign({ key, label, kind, required, validation, affects_outcome: affects }, x ? { 'x-matrix': x } : {});
const YNNA = 'yes · no · n/a';
const ST = (name, approvers, outcome, fields, x) => ({ name, outcome, approvers, fields, 'x-matrix': x });
const NI = (icon, label, page, roles, badge, route) => ({ label, icon, page, badge: badge || null, roles, 'x-matrix': { route } });
const BUDGET_HEADS = ['Professional Fees', 'HVAC', 'Furniture, Light & Planters', 'Civil & Interiors', 'Kitchen Equipment', 'Branding', 'Crockery & Small Equipments', 'Utilities', 'Licencing', 'BD Cost', 'Misc'];
const headKey = (prefix, h) => prefix + '_' + h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const budgetFields = (prefix, note) => BUDGET_HEADS.map((h, i) => F(headKey(prefix, h), h, 'number', true, '₹', false, { column: `site_budget_items(idx=${i + 1}).amount`, note }));

function mod(spec) {
  const stages = spec.stages.map((s, i) => Object.assign({ order: i + 1, name: s.name, outcome: s.outcome, terminal: i === spec.stages.length - 1, approvers: s.approvers, fields: s.fields }, { 'x-matrix': s['x-matrix'] }));
  return {
    key: spec.key, name: spec.name, type: 'builtin', enabled: true, route: '/' + spec.key.replace(/_/g, '-'), state: 'live',
    tiers: { supervisor: true, executive: spec.executive, business_admin_signoff: spec.adminSignoff, delegation: spec.delegation },
    entry_gate: spec.gate ? { match: spec.gate.match || 'all', conditions: spec.gate.conds.map(([source, outcome]) => ({ source, outcome })), refusal_message: spec.gate.refusal } : null,
    stages,
    rollup: { strategy: spec.rollup || 'all_positive' },
    exit_signal: spec.exit,
    navigation: spec.nav,
    'x-matrix': spec.x,
  };
}

// ---------------------------------------------------------------- modules
const modules = [
  mod({
    key: 'bd', name: 'BD', executive: true, adminSignoff: false, delegation: true, exit: 'done', gate: null,
    x: {
      icon: '⇄', band: 'site', y: 320, realModuleKey: 'bd', membershipModule: 'bd', routeGuard: 'require_role only (no require_module on BD routes)',
      state: 'sites.status', statusVocabulary: ['draft_submitted', 'shortlisted', 'details_submitted', 'approved', 'loi_uploaded', 'rejected', 'archived'],
      exitSignal: "sites.status: loi_uploaded → legal_review (BD supervisor 'send to legal')",
      sideExits: ['rejected (supervisor; reasons[] + note)', 'archived (supervisor; note required) — revivable to archived_from_status'],
      sources: ['backend/app/domain/state_machine.py', 'backend/app/services/bd_service.py', 'backend/app/services/loi_service.py', 'backend/app/routers/bd.py', 'backend/app/routers/loi.py', 'backend/app/routers/staging.py', 'backend/app/domain/schemas/site.py', 'frontend/src/modules/shared/chrome/Sidebar.jsx'],
    },
    stages: [
      ST('Draft capture', ['executive'], 'submitted', [
        F('site_name', 'Site name', 'text', true), F('city', 'City', 'text', true), F('visit_date', 'Visit date', 'date', true),
        F('model', 'Store model', 'text', false, 'e.g. BTC Cafe+'), F('spoc_name', 'SPOC name', 'text'),
        F('google_maps_url', 'Google Maps link', 'text', false, '^https?://'),
        F('area_sqft', 'Area (sqft)', 'number', false, 'min 0'),
        F('rent_type', 'Rent type', 'choice', false, 'fixed · revshare · mg_revshare · staggered', false, { fieldGroup: 'rent-terms.json#group', note: 'conditional rent fields per rent-terms.json' }),
        F('expected_rent', 'Expected rent / MG / base rent', 'number', false, '₹ per month; required when staggered'),
        F('staggered_escalation', 'Staggered escalation schedule', 'text', false, '≤ 5 rows {year, percent}', false, { realKind: 'repeater (jsonb)', v5Gap: 'no repeater kind in v5 KINDS' }),
      ], { realState: 'sites.status=draft_submitted', actors: [{ role: 'executive|supervisor', action: 'create draft', route: 'POST /api/bd/drafts' }], note: 'A supervisor-created draft starts at shortlisted (skips this review).', sources: ['backend/app/domain/schemas/site.py CreateDraftRequest', 'backend/app/services/bd_service.py svc_create_draft'] }),
      ST('Shortlist review', ['supervisor'], 'allocated', [
        F('rejection_reasons', 'Rejection reasons', 'text', false, 'list; used only when rejecting'),
      ], { realState: 'sites.status: draft_submitted → shortlisted', actors: [{ role: 'supervisor', action: 'shortlist / reject / archive', route: 'POST /api/bd/drafts/{site_id}/shortlist|reject|archive' }], rules: ['a non-supervising caller cannot shortlist its own draft (_assert_not_self_approval)'], sources: ['backend/app/services/bd_service.py svc_shortlist_draft'] }),
      ST('Details review', ['supervisor'], 'approved', [
        F('score', 'Score', 'number', false, 'min 1 · max 5'),
        F('est_sales', 'Estimated monthly sales', 'number', false, '₹'),
        F('nearest_starbucks_m', 'Nearest Starbucks (m)', 'number', false, null, false, { tenantSpecific: true }),
        F('nearest_twc_m', 'Nearest Third Wave (m)', 'number', false, null, false, { tenantSpecific: true }),
        F('carpet_area_sqft', 'Carpet area (sqft)', 'number'),
        F('cam_charges', 'CAM charges', 'number', false, '₹'),
        F('rent', 'Rent', 'number', false, '₹ per month'),
        F('security_deposit', 'Security deposit', 'number', false, '₹'),
        F('capex', 'Capex', 'number', false, '₹'),
        F('brokerage', 'Brokerage', 'number', false, '₹'),
        F('lock_in_months', 'Lock-in (months)', 'number'),
        F('tenure_months', 'Tenure (months)', 'number'),
        F('rent_free_days', 'Rent-free days', 'number'),
        F('expected_loi_days', 'Expected LOI days', 'number', true, 'set by the supervisor at approval → LOI deadline'),
      ], { realState: 'sites.status: shortlisted → details_submitted (executive submits) → approved (supervisor)', actors: [{ role: 'executive|supervisor', action: 'save details (partial 17-field form)', route: 'POST /api/bd/shortlist/{site_id}/details/save' }, { role: 'executive', action: 'submit for review', route: 'POST /api/bd/shortlist/{site_id}/submit' }, { role: 'supervisor', action: 'approve', route: 'POST /api/bd/shortlist/{site_id}/approve' }], derived: ['total_op_cost = (rent + cam) × 1.18'], undo: 'business_admin can undo the approval (reversible_actions)', sources: ['backend/app/domain/schemas/site.py SaveDetailsRequest, ApproveShortlistRequest', 'backend/app/services/bd_service.py svc_submit_details, svc_approve_shortlist', 'backend/app/services/_common.py _extract_details'] }),
      ST('LOI', ['supervisor'], 'done', [
        F('loi_document', 'Signed LOI', 'file', true, 'stored in Supabase Storage (site_files.file_type=loi)'),
        F('loi_send_back_comments', 'Send-back comments', 'text', false, 'required when the supervisor sends the LOI back'),
      ], { realState: 'sites.status: approved → loi_uploaded → legal_review', actors: [{ role: 'executive', action: 'upload LOI', route: 'POST /api/loi/{site_id}/upload' }, { role: 'supervisor', action: 'set LOI timeline', route: 'POST /api/loi/{site_id}/set-timeline' }, { role: 'supervisor', action: 'send back (→ approved)', route: 'POST /api/loi/{site_id}/send-back' }, { role: 'supervisor', action: 'send to Legal (→ legal_review)', route: 'POST /api/staging/{site_id}/push' }], sendBack: 'loi_uploaded → approved', note: 'Finance opens at upload (before send-to-legal); Legal opens at send-to-legal.', sources: ['backend/app/services/loi_service.py', 'backend/app/services/bd_service.py svc_push_to_payments'] }),
    ],
    nav: [
      { section: 'Overview', items: [NI('⌂', 'Sites', 'sites', B, null, '/')] },
      { section: 'Workflow', items: [
        NI('▤', 'Pipeline', 'pipeline', B, 'queue', '/pipeline'), NI('★', 'Shortlisted sites', 'shortlisted', B, 'shortlisted', '/shortlist'),
        NI('↻', 'Sites in process', 'in_process', B, 'in_process', '/staging'), NI('◫', 'Archived / Rejected', 'archived', S, 'archived', '/archive'),
        NI('✕', 'DDR negative', 'ddr', B, null, '/dd-failed'), NI('⇅', 'Process flow', 'process', B, null, '/staging-flow'),
        NI('∑', 'Payment', 'payment', B, null, '/payment'), NI('↗', 'Launch', 'launch', B, null, '/launch')] },
      { section: 'Workspace', items: [NI('⧉', 'Team', 'team', B, 'team', '/team')] },
    ],
  }),

  mod({
    key: 'legal', name: 'Legal & Compliance', executive: true, adminSignoff: false, delegation: true, exit: 'done',
    gate: { conds: [['bd', 'done']], refusal: 'Legal & Compliance is locked: waiting for BD to send the signed LOI to Legal.' },
    x: {
      icon: '§', band: 'legalfin', y: 230, changeRequestLoop: true, realModuleKey: 'legal', membershipModule: 'legal', routeGuard: "require_module('legal')",
      realGate: "sites.status ∈ {legal_review, legal_rejected} (BD supervisor: LOI_UPLOADED → LEGAL_REVIEW; seeds legal_dd_checklist)",
      state: 'legal_dd_checklist, site_agreement, site_licensing → sites.legal_dd_status / agreement_status / licensing_status, sites.status',
      exitSignal: 'licensing complete → sites.status legal_review → legal_approved (then pushed_to_payments once finance is approved)',
      intermediateSignal: "DDR positive → sites.legal_dd_status='positive' (this — not full Legal completion — is what Design waits for)",
      loops: ['negative DDR → sites.status legal_rejected; an approved BD change request that flips the last failing item revives the site to legal_review (change_request_service._maybe_recover_dd_verdict)', 'executives may only edit while a row is in stage=draft and only with a legal site_delegation'],
      sources: ['backend/app/services/legal_service.py', 'backend/app/services/change_request_service.py', 'backend/app/routers/legal.py', 'backend/app/domain/schemas/legal.py'],
    },
    stages: [
      ST('DDR (due diligence report)', ['supervisor'], 'approved', [
        F('dd_title_doc', 'Title document', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.title_doc' }),
        F('dd_sanctioned_plan', 'Sanctioned plan', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.sanctioned_plan' }),
        F('dd_oc_cc', 'OC / CC', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.oc_cc' }),
        F('dd_commercial_use', 'Commercial use permitted', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.commercial_use' }),
        F('dd_property_tax', 'Property tax', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.property_tax' }),
        F('dd_electricity', 'Electricity', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.electricity' }),
        F('dd_fire_noc', 'Fire NOC', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.fire_noc' }),
        F('dd_other_1', 'Other check 1 (custom label)', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.other_1 (+ other_1_label)' }),
        F('dd_other_2', 'Other check 2 (custom label)', 'choice', false, YNNA, true, { column: 'legal_dd_checklist.other_2 (+ other_2_label)' }),
        F('dd_final_verdict', 'Final verdict', 'choice', true, 'positive · negative', true, { column: 'legal_dd_checklist.final_verdict', note: 'stamped by the supervisor, NOT computed from the items' }),
        F('dd_rejection_reason', 'Rejection reason', 'text', false, 'required when the verdict is negative'),
      ], { realState: "legal_dd_checklist.stage draft → pending_review → published; final_verdict positive|negative", actors: [{ role: 'executive (delegated)|supervisor', action: 'fill items', route: 'POST /api/legal/{site_id}/dd/items' }, { role: 'executive|supervisor', action: 'submit for review', route: 'POST /api/legal/{site_id}/dd/submit-for-review' }, { role: 'supervisor', action: 'finalise verdict', route: 'POST /api/legal/{site_id}/dd/finalize' }], negativeOutcome: 'rejected (sites.status=legal_rejected)', sources: ['backend/app/services/legal_service.py svc_save_verification, svc_submit_dd_for_review, svc_save_due_diligence'] }),
      ST('Agreement', ['supervisor'], 'submitted', [
        F('agr_signed', 'Agreement signed', 'yesno', false), F('agr_registered', 'Agreement registered', 'yesno', false), F('agr_document', 'Agreement document', 'file', false),
      ], { realState: 'site_agreement.signed/registered → sites.agreement_status pending|signed|registered', stageGate: 'published positive DDR', actors: [{ role: 'supervisor', action: 'save agreement', route: 'POST /api/legal/{site_id}/agreement' }], sources: ['backend/app/services/legal_service.py svc_save_agreement'] }),
      ST('Licensing', ['supervisor'], 'done', [
        F('lic_fssai', 'FSSAI', 'choice', true, YNNA, true), F('lic_health_trade', 'Health & trade', 'choice', true, YNNA, true),
        F('lic_shops_estab', 'Shops & establishment', 'choice', true, YNNA, true), F('lic_fire_noc', 'Fire NOC', 'choice', true, YNNA, true),
        F('lic_storage', 'Storage licence', 'choice', true, YNNA, true),
      ], { realState: 'site_licensing (5 items, stage) → sites.licensing_status pending|partial|complete', stageGate: 'published positive DDR AND agreement signed or registered', rollup: 'all_positive: every item yes or na; only a supervisor save publishes', actors: [{ role: 'executive (delegated)|supervisor', action: 'save items', route: 'POST /api/legal/{site_id}/licensing' }, { role: 'executive|supervisor', action: 'submit for review', route: 'POST /api/legal/{site_id}/licensing/submit-for-review' }], sources: ['backend/app/services/legal_service.py svc_save_licensing'] }),
    ],
    nav: [{ section: 'Legal', items: [NI('⌂', 'Overview', 'overview', B, null, '/legal/overview'), NI('▤', 'Sites', 'sites', B, null, '/legal'), NI('‡', 'Change requests', 'change_requests', B, 'change_requests', '/legal/change-requests'), NI('⇅', 'Process flow', 'process', B, null, '/legal/process-flow'), NI('↻', 'History', 'history', B, null, '/legal/history')] }],
  }),

  mod({
    key: 'finance_ca', name: 'CA / Commercial Code', executive: true, adminSignoff: true, delegation: false, exit: 'approved',
    gate: { conds: [['bd', 'done']], refusal: 'Finance details can only be entered after the LOI is uploaded.' },
    x: {
      icon: '∑', band: 'legalfin', y: 420, realModuleKey: null, membershipModule: null, routeGuard: 'require_role only — finance lives in the BD Site Tracker (Finance tab) and the business-admin portal; no module of its own',
      realGate: 'sites.status ∈ {loi_uploaded, legal_review, legal_approved, pushed_to_payments} — opens at LOI UPLOAD, i.e. before BD sends to Legal (v5 cannot express this: both happen inside BD\'s LOI stage)',
      state: 'sites.finance_status (+ kyc_verified, ca_code, finance_amount)', statusVocabulary: ['pending', 'awaiting_supervisor', 'awaiting_admin', 'approved'],
      exitSignal: "sites.finance_status='approved' (may unlock Design via workflow_unlocks.maybe_unlock_design; also NSO stage one)",
      loops: ['either tier rejects → pending (fields unlock)'],
      sources: ['backend/app/services/finance_service.py', 'backend/app/routers/sites.py', 'backend/app/routers/business_admin.py', 'backend/app/services/workflow_unlocks.py'],
    },
    stages: [
      ST('CA code & KYC', ['executive'], 'submitted', [
        F('kyc_verified', 'KYC verified', 'yesno', true), F('ca_code', 'CA / Commercial code', 'text', true, 'unique per workspace, case-insensitive; becomes the site display code'), F('finance_amount', 'Amount', 'number', true, '₹'),
      ], { realState: 'finance_status pending → awaiting_supervisor', actors: [{ role: 'executive (owner)|supervisor', action: 'save draft', route: 'PATCH /api/sites/{site_id}/finance' }, { role: 'executive|supervisor', action: 'request approval', route: 'POST /api/sites/{site_id}/finance/request-approval' }], sources: ['backend/app/services/finance_service.py svc_save_finance_draft, svc_finance_request_approval'] }),
      ST('Supervisor review', ['supervisor'], 'submitted', [], { realState: 'awaiting_supervisor → awaiting_admin | pending (reject)', actors: [{ role: 'supervisor', action: 'approve / reject', route: 'POST /api/sites/{site_id}/finance/approve|reject' }], sources: ['backend/app/services/finance_service.py svc_finance_approve, svc_finance_reject'] }),
      ST('Admin approval', ['business_admin'], 'approved', [], { realState: 'awaiting_admin → approved | pending (reject)', actors: [{ role: 'business_admin', action: 'approve / reject', route: 'POST /api/business-admin/finance-approvals/{site_id}/approve|reject' }], sources: ['backend/app/services/business_admin_service.py approve_finance'] }),
    ],
    nav: [{ section: 'Finance', items: [NI('∑', 'Payment', 'payment', B, null, '/payment'), NI('▤', 'Site finance', 'sites', B, 'queue', '/sites/:siteId/finance')] }],
  }),

  mod({
    key: 'design', name: 'Design / Technical', executive: true, adminSignoff: true, delegation: true, exit: 'approved',
    gate: { conds: [['legal', 'approved'], ['finance_ca', 'approved']], refusal: 'Design is locked: waiting for a positive DDR and Finance approval.' },
    x: {
      icon: '◪', band: 'design', y: 320, realModuleKey: 'design', membershipModule: 'design', routeGuard: "require_module('design') for members; business_admin routes have no module guard",
      realGate: "workflow_unlocks.design_unlock_ready: sites.legal_dd_status='positive' AND sites.finance_status='approved'",
      state: 'design_reviews.current_stage + design_deliverables(kind) → sites.design_status', statusVocabulary: ['pending', 'allocated', 'in_progress', 'gfc_pending', 'approved', 'rejected'],
      exitSignal: "GFC approved → sites.design_status='approved' (opens Project Excellence AND Project)",
      loops: ['supervisor reject → re-upload same kind', 'admin send-back on 2D/3D → back to supervisor', 'GFC reject → current_stage=3d', 'supervisor + admin 2D/3D decisions undoable (reversible_actions)'],
      retired: ['BOQ is no longer a design step (kind kept for history); the 11-head budget moved to Project Excellence'],
      sources: ['backend/app/services/design_service.py', 'backend/app/routers/design.py'],
    },
    stages: [
      ST('Recce', ['supervisor'], 'submitted', [F('recce_pack', 'Recce pack', 'file', true), F('recce_supervisor_comments', 'Supervisor comments', 'text')], { realState: "design_deliverables(kind=recce).status pending → submitted → approved|rejected", preStep: 'supervisor allocates a design executive (or self) → design_status=allocated (POST /api/design/{site_id}/allocate)', actors: [{ role: 'executive|supervisor', action: 'upload (supervisor self-upload auto-approves)', route: 'POST /api/design/{site_id}/deliverables/recce/upload' }, { role: 'supervisor', action: 'review', route: 'POST /api/design/{site_id}/deliverables/recce/review' }], sources: ['backend/app/services/design_service.py _NEXT_STAGE, svc_submit_deliverable, svc_review_deliverable'] }),
      ST('2D drawing', ['supervisor', 'business_admin'], 'in progress', [F('drawing_2d', '2D drawing', 'file', true), F('drawing_2d_admin_comments', 'Admin comments', 'text')], { realState: 'deliverable(2d).status + admin_status', actors: [{ role: 'executive|supervisor', action: 'upload', route: 'POST /api/design/{site_id}/deliverables/2d/upload' }, { role: 'supervisor', action: 'review', route: 'POST /api/design/{site_id}/deliverables/2d/review' }, { role: 'business_admin', action: 'admin review', route: 'POST /api/design/{site_id}/deliverables/2d/admin-review' }], sources: ['backend/app/services/design_service.py _NEEDS_ADMIN={2d,3d}'] }),
      ST('3D render', ['supervisor', 'business_admin'], 'in progress', [F('drawing_3d', '3D render', 'file', true), F('drawing_3d_admin_comments', 'Admin comments', 'text')], { realState: 'deliverable(3d).status + admin_status → current_stage=gfc', actors: [{ role: 'executive|supervisor', action: 'upload', route: 'POST /api/design/{site_id}/deliverables/3d/upload' }, { role: 'supervisor', action: 'review', route: 'POST /api/design/{site_id}/deliverables/3d/review' }, { role: 'business_admin', action: 'admin review', route: 'POST /api/design/{site_id}/deliverables/3d/admin-review' }], sources: ['backend/app/services/design_service.py'] }),
      ST('GFC approval', ['business_admin'], 'approved', [F('gfc_comments', 'GFC comments', 'text')], { realState: "design_status in_progress → gfc_pending (supervisor sends) → approved | 3D revision", actors: [{ role: 'supervisor', action: 'send for GFC', route: 'POST /api/design/{site_id}/gfc-request' }, { role: 'business_admin', action: 'GFC decision', route: 'POST /api/design/gfc/{site_id}' }], sources: ['backend/app/services/design_service.py svc_request_gfc_approval, svc_gfc_decision'] }),
    ],
    nav: [{ section: 'Design', items: [NI('⌂', 'Overview', 'overview', B, null, '/design/overview'), NI('▤', 'Sites', 'sites', B, null, '/design'), NI('⇅', 'Process flow', 'process', B, null, '/design/process-flow'), NI('↻', 'History', 'history', B, null, '/design/history')] }],
  }),

  mod({
    key: 'pex', name: 'Project Excellence', executive: true, adminSignoff: true, delegation: true, exit: 'approved',
    gate: { conds: [['design', 'approved']], refusal: 'Project Excellence is locked until Design GFC is approved.' },
    x: {
      icon: '✦', band: 'build', y: 230, realModuleKey: 'project_excellence', membershipModule: 'project_excellence', routeGuard: "require_module('project_excellence')",
      realGate: "sites.design_status='approved'",
      state: "site_budgets(phase='gfc') + site_budget_items(idx 1..11) → sites.project_excellence_status", statusVocabulary: ['pending', 'allocated', 'budgeting', 'approved'],
      exitSignal: "budget approved → seeds Project initialization (project_service.seed_initialization_from_pe)",
      sources: ['backend/app/services/project_excellence_service.py', 'backend/app/services/budget_service.py', 'backend/app/services/project_service.py', 'backend/app/routers/project_excellence.py'],
    },
    stages: [
      ST('GFC budget (11 heads)', ['executive', 'supervisor'], 'submitted', [
        ...budgetFields('pex', 'phase=gfc baseline'),
        F('pex_total_indoor_area_sqft', 'Total indoor area (sqft)', 'number'), F('pex_total_area_sqft', 'Total area (sqft)', 'number'), F('pex_covers', 'Covers', 'number'),
        F('pex_documents', 'Budget documents', 'file', false, 'PNG/JPEG/PDF ≤ 5 MB'),
      ], { realState: "site_budgets.status draft → pending_supervisor (executive submit) | pending_admin (supervisor submit)", preStep: 'supervisor delegates to an executive or self (POST /api/project-excellence/{site_id}/allocate)', actors: [{ role: 'executive|supervisor', action: 'save / submit', route: 'POST /api/project-excellence/{site_id}/budget' }], v5Gap: 'v5 had one number field "Budget lines (11)"; the real form is 11 labelled heads', sources: ['backend/app/services/budget_service.py BUDGET_LABELS', 'backend/app/services/project_excellence_service.py svc_save_pe_budget'] }),
      ST('Supervisor review', ['supervisor'], 'submitted', [F('pex_supervisor_comments', 'Supervisor comments', 'text')], { realState: 'pending_supervisor → pending_admin | rejected', actors: [{ role: 'supervisor', action: 'review', route: 'POST /api/project-excellence/{site_id}/budget/review' }], sources: ['backend/app/services/project_excellence_service.py svc_review_pe_budget'] }),
      ST('Admin review', ['business_admin'], 'approved', [F('pex_admin_comments', 'Admin comments', 'text')], { realState: 'pending_admin → approved | rejected', actors: [{ role: 'business_admin', action: 'approve / reject', route: 'POST /api/project-excellence/{site_id}/budget/admin-review' }], sources: ['backend/app/services/project_excellence_service.py svc_admin_review_pe_budget'] }),
      ST('Quality-audit reports', ['supervisor'], 'done', [F('qa_before_report', 'Quality audit — before', 'file', true, 'PDF'), F('qa_after_report', 'Quality audit — after', 'file', true, 'PDF')], { realState: "quality_audit_reports(kind before|after, pushed_at)", stageGate: "Project's quality audit is ready (after the mid-project visit) — a cross-module STAGE dependency", actors: [{ role: 'supervisor', action: 'delegate the QA-report task (site_delegations module=quality_audit)', route: 'POST /api/project-excellence/{site_id}/quality-audit/allocate' }, { role: 'executive (delegated)|supervisor', action: 'upload + push (pushing before completes the Project)', route: 'POST /api/project-excellence/{site_id}/quality-audit/report/{kind}/upload|push' }, { role: 'supervisor', action: 'mark quality audit completed (alternative completion path)', route: 'POST /api/project-excellence/{site_id}/quality-audit/complete' }], note: 'Runs AFTER this module\'s exit signal; feeds Project\'s completion and NSO hand-over.', sources: ['backend/app/services/project_service.py svc_record_qa_report, svc_push_qa_report, svc_pe_complete_quality_audit'] }),
    ],
    nav: [{ section: 'Project Excellence', items: [NI('⌂', 'Overview', 'overview', B, null, '/project-excellence/overview'), NI('▤', 'Pipeline', 'pipeline', B, 'queue', '/project-excellence'), NI('◨', 'Quality Audit', 'audit', B, null, '/project-excellence/quality-audit'), NI('↻', 'History', 'history', B, null, '/project-excellence/history')] }],
  }),

  mod({
    key: 'project', name: 'Project Execution', executive: true, adminSignoff: true, delegation: true, exit: 'done',
    gate: { conds: [['design', 'approved']], refusal: 'Project is locked until Design receives final GFC approval.' },
    x: {
      icon: '▦', band: 'build', y: 420, realModuleKey: 'project', membershipModule: 'project', routeGuard: "require_module('project') (also guards Financial Closure routes)",
      realGate: "sites.design_status='approved' (project_service._assert_project_unlocked)",
      state: 'project_reviews → sites.project_status', statusVocabulary: ['pending', 'allocated', 'in_progress', 'done'],
      exitSignal: "project done + pushed → nso_reviews.handover_pushed_at (NSO opens at stage three)",
      sources: ['backend/app/services/project_service.py', 'backend/app/routers/project.py'],
    },
    stages: [
      ST('Initialization date', ['supervisor', 'executive'], 'allocated', [F('initialization_date', 'Initialization date', 'date', true)], { realState: 'initialization_status pending → proposed → approved | rejected → (supervisor finalises)', stageGate: 'Project Excellence budget approved (seed_initialization_from_pe) — a cross-module STAGE dependency', preStep: 'supervisor allocates (POST /api/project/{site_id}/allocate) → project_status=allocated', actors: [{ role: 'supervisor', action: 'propose', route: 'POST /api/project/{site_id}/initialization/propose' }, { role: 'executive', action: 'accept / reject', route: 'POST /api/project/{site_id}/initialization/respond' }, { role: 'supervisor', action: 'finalise after rejection', route: 'POST /api/project/{site_id}/initialization/finalize' }], sources: ['backend/app/services/project_service.py svc_propose/respond/finalize_initialization'] }),
      ST('Expected completion', ['supervisor'], 'submitted', [F('expected_completion_date', 'Expected completion date', 'date', true)], { realState: 'expected_completion_status pending → submitted → approved | rejected', actors: [{ role: 'executive|supervisor', action: 'submit', route: 'POST /api/project/{site_id}/milestone/{field}' }, { role: 'supervisor', action: 'approve / reject', route: 'POST /api/project/{site_id}/milestone/{field}/review' }], sources: ['backend/app/services/project_service.py svc_submit_milestone, svc_review_milestone'] }),
      ST('Mid-project visit', ['supervisor'], 'in progress', [F('mid_project_visit_date', 'Mid-project visit date', 'date', true)], { realState: 'project_reviews.mid_project_visit_date', actors: [{ role: 'supervisor', action: 'set date', route: 'POST /api/project/{site_id}/mid-project-visit' }], sources: ['backend/app/services/project_service.py svc_set_mid_visit'] }),
      ST('Quality audit', ['supervisor', 'business_admin'], 'approved', [F('inspection_date', 'Inspection date', 'date', true), F('quality_audit_comments', 'Comments', 'text')], { realState: 'quality_audit_status pending → submitted → supervisor_approved → approved (project_status=done) | rejected', actors: [{ role: 'executive|supervisor', action: 'record inspection date', route: 'POST /api/project/{site_id}/quality-audit/inspection-date' }, { role: 'supervisor', action: 'approve', route: 'POST /api/project/{site_id}/quality-audit/supervisor-approve' }, { role: 'business_admin', action: 'confirm → project completes', route: 'POST /api/project/{site_id}/quality-audit/admin-confirm' }], alternative: 'Project Excellence supervisor completion / QA report push also completes the project (two modules co-own this stage)', sources: ['backend/app/services/project_service.py svc_submit_inspection_date, svc_supervisor_approve_quality_audit, svc_admin_confirm_quality_audit'] }),
      ST('Push to NSO', ['supervisor'], 'done', [], { realState: "project_reviews.nso_status pending → pushed; nso_reviews.handover_pushed_at", stageGate: "project done AND both QA reports ('before' and 'after') uploaded and pushed by Project Excellence", actors: [{ role: 'supervisor', action: 'push from the NSO Handover tab', route: 'POST /api/project/{site_id}/push-to-nso' }], sources: ['backend/app/services/project_service.py svc_push_to_nso'] }),
    ],
    nav: [{ section: 'Project', items: [NI('⌂', 'Overview', 'overview', B, null, '/project/overview'), NI('▤', 'Pipeline', 'pipeline', B, 'queue', '/project'), NI('◫', 'Sites', 'sites', B, null, '/project/sites'), NI('↗', 'NSO Handover', 'handover', B, null, '/project/nso-handover'), NI('∑', 'Financial Closure', 'closure', B, null, '/project/financial-closure'), NI('⇅', 'Process flow', 'process', B, null, '/project/process-flow'), NI('↻', 'History', 'history', B, null, '/project/history')] }],
  }),

  mod({
    key: 'nso', name: 'NSO', executive: false, adminSignoff: false, delegation: false, exit: 'done',
    gate: { conds: [['finance_ca', 'approved']], refusal: 'NSO Stage 1 is locked until Finance / CA is approved.' },
    x: {
      icon: '★', band: 'audit', y: 320, realModuleKey: 'nso', membershipModule: 'nso', routeGuard: "require_role(SUPERVISOR) + require_module('nso') on EVERY route — supervisor-only",
      realGate: "_trigger_one_unlocked: finance_status='approved' AND ca_code set",
      state: 'nso_reviews', statusVocabulary: ['pending', 'in_progress', 'complete'], stageVocabulary: ['stage_one', 'stage_two', 'stage_three', 'final', 'done'],
      exitSignal: 'final approval → creates launch_approvals (status pending_admin_review)',
      sources: ['backend/app/services/nso_service.py', 'backend/app/routers/nso.py', 'backend/app/services/licensing_status.py'],
    },
    stages: [
      ST('Stage 1 · Property & communication', ['supervisor'], 'submitted', [F('property_details', 'Property details', 'text', true), F('communication_floated', 'Communication floated', 'yesno', true)], { realState: 'current_stage=stage_one; complete when communication_floated is set', actors: [{ role: 'supervisor', action: 'save', route: 'POST|PATCH /api/nso/{site_id}/stage-one' }], sources: ['backend/app/services/nso_service.py svc_save_stage_one, _stage_one_complete'] }),
      ST('Stage 2 · Licensing (from Legal)', ['supervisor'], 'in progress', [
        F('nso_fssai', 'FSSAI', 'choice', false, 'pending · done', true, { derivedFrom: 'site_licensing.fssai (read-only mirror)' }),
        F('nso_health_trade', 'Health & trade', 'choice', false, 'pending · done', true, { derivedFrom: 'site_licensing.health_trade' }),
        F('nso_shops_estab', 'Shops & establishment', 'choice', false, 'pending · done', true, { derivedFrom: 'site_licensing.shops_estab_reg' }),
        F('nso_fire_noc', 'Fire NOC', 'choice', false, 'pending · done', true, { derivedFrom: 'site_licensing.fire_noc' }),
        F('nso_storage_licence', 'Storage licence', 'choice', false, 'pending · done', true, { derivedFrom: 'site_licensing.storage_license' }),
      ], { realState: 'current_stage=stage_two', stageGate: 'stage one complete AND Project initialization approved (cross-module STAGE dependency)', note: 'Legal is the single source of truth; nso_reviews.*_status columns are never synced (#229)', actors: [{ role: 'supervisor', action: 'refresh from Legal', route: 'POST|PATCH /api/nso/{site_id}/stage-two' }], sources: ['backend/app/services/nso_service.py _stage_two_unlocked, svc_save_stage_two', 'backend/app/services/licensing_status.py'] }),
      ST('Stage 3 · Launch readiness', ['supervisor'], 'in progress', [
        F('dry_stock_order', 'Dry stock order', 'choice', true, 'pending · ordered · received', true), F('online_delivery', 'Online delivery', 'choice', true, 'pending · ready · active', true),
        F('handover_checklist_signed', 'Handover checklist signed', 'yesno', true, null, true), F('launch_date', 'Launch date', 'date', true), F('launch_ready', 'Launch ready', 'yesno', true),
      ], { realState: 'current_stage=stage_three', stageGate: 'Project pushed the site (handover_pushed_at) AND Legal licensing complete AND Project done — three-source STAGE gate', actors: [{ role: 'supervisor', action: 'save checklist', route: 'POST|PATCH /api/nso/{site_id}/stage-three' }], sources: ['backend/app/services/nso_service.py _stage_three_unlocked, _stage_three_complete'] }),
      ST('Final approval', ['supervisor'], 'done', [F('final_signoff_1', 'Sign-off 1', 'yesno', true, null, true), F('final_signoff_2', 'Sign-off 2', 'yesno', true, null, true)], { realState: "current_stage=final → done; nso_status=complete", actors: [{ role: 'supervisor', action: 'final approval (creates the launch approval row)', route: 'POST /api/nso/{site_id}/final-approval' }], sources: ['backend/app/services/nso_service.py svc_final_approval'] }),
    ],
    nav: [{ section: 'NSO', items: [NI('⌂', 'Overview', 'overview', S, null, '/nso/overview'), NI('▤', 'Sites', 'sites', S, null, '/nso'), NI('⇅', 'Process flow', 'process', S, null, '/nso/process-flow'), NI('↻', 'History', 'history', S, null, '/nso/history')] }],
  }),

  mod({
    key: 'launch_approval', name: 'Launch Approval', executive: true, adminSignoff: true, delegation: false, exit: 'done',
    gate: { conds: [['nso', 'done']], refusal: 'Launch approval is locked: waiting for NSO final approval.' },
    x: {
      icon: '↗', band: 'launch', y: 230, realModuleKey: null, membershipModule: null, routeGuard: 'require_role only (business_admin / site creator / supervisor)',
      realGate: 'created by nso_service.svc_final_approval',
      state: 'launch_approvals (staging copy of rent + commercial terms) + launch_review_events', statusVocabulary: ['pending_admin_review', 'under_exec_review', 'under_supervisor_review', 'pending_admin_final', 'ready_to_launch', 'launched'],
      exitSignal: 'sites.is_launched=true (sites.status untouched)',
      rollupNote: 'verdicts are recorded and flow FORWARD (never bounce); the admin confirm decides — not expressible as a v5 roll-up strategy',
      sources: ['backend/app/services/launch_service.py', 'backend/app/domain/schemas/launch.py', 'backend/app/routers/launch_approval.py'],
    },
    stages: [
      ST('Admin review', ['business_admin'], 'submitted', [F('rent_terms', 'Rent terms', 'text', false, 'field group rent-terms.json', false, { fieldGroup: 'rent-terms.json#group' }), F('admin_review_comment', 'Admin comment', 'text')], { realState: 'pending_admin_review → under_exec_review', editRights: ['business_admin: rent + commercial terms'], actors: [{ role: 'business_admin', action: 'send for review', route: 'POST /api/launch-approvals/{site_id}/send-for-review' }], sources: ['backend/app/services/launch_service.py svc_admin_send_for_review, _EDIT_ALLOWED'] }),
      ST('Creator review', ['executive'], 'submitted', [F('exec_verdict', 'Verdict', 'choice', true, 'approved · rejected'), F('exec_comment', 'Comment', 'text'), F('rent_start_date', 'Rent start date', 'date', true, 'the only field the creator may edit')], { realState: 'under_exec_review → under_supervisor_review', actor: 'the SITE CREATOR (executive, or a supervisor who created the pipeline)', actors: [{ role: 'executive|supervisor (creator)', action: 'record verdict', route: 'POST /api/launch-approvals/{site_id}/exec-review' }], sources: ['backend/app/services/launch_service.py svc_exec_review, _RENT_START_EDIT_ALLOWED'] }),
      ST('Supervisor review', ['supervisor'], 'submitted', [F('supervisor_verdict', 'Verdict', 'choice', true, 'approved · rejected'), F('supervisor_comment', 'Comment', 'text')], { realState: 'under_supervisor_review → pending_admin_final', editRights: ['supervisor: rent + commercial terms'], actors: [{ role: 'supervisor', action: 'record verdict', route: 'POST /api/launch-approvals/{site_id}/supervisor-review' }], sources: ['backend/app/services/launch_service.py svc_supervisor_review'] }),
      ST('Admin final confirm', ['business_admin'], 'approved', [F('admin_final_comment', 'Final comment', 'text')], { realState: 'pending_admin_final → ready_to_launch; COMMITS staging into sites + site_details', actors: [{ role: 'business_admin', action: 'confirm', route: 'POST /api/launch-approvals/{site_id}/final-confirm' }], sources: ['backend/app/services/launch_service.py svc_admin_final_confirm, _commit_rent_to_canonical'] }),
      ST('Launch', ['business_admin'], 'done', [], { realState: 'ready_to_launch → launched; sites.is_launched=true', actors: [{ role: 'business_admin', action: 'launch', route: 'POST /api/launch-approvals/{site_id}/launch' }], sources: ['backend/app/services/launch_service.py svc_launch'] }),
    ],
    nav: [{ section: 'Launch', items: [NI('↗', 'Launch', 'launch', B, 'queue', '/launch')] }],
  }),

  mod({
    key: 'financial_closure', name: 'Financial Closure', executive: true, adminSignoff: true, delegation: true, exit: 'done',
    gate: { conds: [['launch_approval', 'done']], refusal: 'Financial Closure opens only after the site is launched.' },
    x: {
      icon: '⧉', band: 'launch', y: 420, realModuleKey: 'financial_closure', membershipModule: null, routeGuard: "require_module('project') — the Project team does closure; site_delegations scope 'financial_closure'",
      realGate: "sites.is_launched AND business_admin 'send for financial closure' (financial_closure_status != 'pending')",
      state: "site_budgets(phase='closure') + 11 items (variation vs gfc) → sites.financial_closure_status", statusVocabulary: ['pending', 'open', 'allocated', 'budgeting', 'closed'],
      exitSignal: "financial_closure_status='closed' (site archived to the admin history)",
      sources: ['backend/app/services/financial_closure_service.py', 'backend/app/routers/financial_closure.py', 'backend/app/services/budget_service.py'],
    },
    stages: [
      ST('Send for closure', ['business_admin'], 'allocated', [], { realState: "financial_closure_status pending → open (closure budget seeded from the gfc labels)", actors: [{ role: 'business_admin', action: 'send for financial closure', route: 'POST /api/financial-closure/{site_id}/send' }, { role: 'supervisor (project)', action: 'allocate (or self)', route: 'POST /api/financial-closure/{site_id}/allocate' }], sources: ['backend/app/services/financial_closure_service.py svc_send_for_financial_closure, svc_allocate_fc'] }),
      ST('Actuals (11 heads)', ['executive', 'supervisor'], 'submitted', budgetFields('fc', 'phase=closure actual; UI shows variation vs gfc'), { realState: 'site_budgets(closure).status draft → pending_supervisor | pending_admin', actors: [{ role: 'executive|supervisor (project)', action: 'save / submit', route: 'POST /api/financial-closure/{site_id}/budget' }], sources: ['backend/app/services/financial_closure_service.py svc_save_fc_budget, _compute_variation'] }),
      ST('Supervisor review', ['supervisor'], 'submitted', [], { realState: 'pending_supervisor → pending_admin | rejected', actors: [{ role: 'supervisor (project)', action: 'review', route: 'POST /api/financial-closure/{site_id}/budget/review' }], sources: ['backend/app/services/financial_closure_service.py svc_review_fc_budget'] }),
      ST('Closure sign-off', ['business_admin'], 'done', [], { realState: "pending_admin → approved; financial_closure_status=closed", actors: [{ role: 'business_admin', action: 'approve + Financial Closure button', route: 'POST /api/financial-closure/{site_id}/finalize' }], sources: ['backend/app/services/financial_closure_service.py svc_admin_finalize_fc'] }),
    ],
    nav: [{ section: 'Closure', items: [NI('∑', 'Financial Closure', 'closure', B, null, '/project/financial-closure')] }],
  }),
];

// ---------------------------------------------------------------- permissions (real, no tenant narrowing exists)
const P = (action, roles, source) => ({ action, platform_ceiling: roles, granted: roles, 'x-matrix': { source } });
const permissions = [
  P('create_draft', ['executive', 'supervisor'], 'POST /api/bd/drafts'),
  P('save_draft_details', ['executive', 'supervisor'], 'POST /api/bd/shortlist/{id}/details/save'),
  P('submit_details_for_review', ['executive'], 'POST /api/bd/shortlist/{id}/submit'),
  P('upload_loi', ['executive'], 'POST /api/loi/{id}/upload'),
  P('shortlist', ['supervisor', 'business_admin'], 'POST /api/bd/drafts/{id}/shortlist (+ READ_ALL bypass)'),
  P('approve_details', ['supervisor', 'business_admin'], 'POST /api/bd/shortlist/{id}/approve (+ bypass)'),
  P('reject', ['supervisor', 'business_admin'], 'POST /api/bd/drafts/{id}/reject, /api/sites/{id}/reject (+ bypass)'),
  P('archive', ['supervisor', 'business_admin'], 'POST /api/bd/drafts/{id}/archive, /api/sites/{id}/archive (+ bypass)'),
  P('set_loi_timeline', ['supervisor'], 'POST /api/loi/{id}/set-timeline'),
  P('send_to_legal', ['supervisor'], 'POST /api/staging/{id}/push'),
  P('reassign_site', ['supervisor', 'business_admin'], 'POST /api/bd/shortlist/{id}/reassign (+ bypass)'),
  P('finance_request_approval', ['executive', 'supervisor'], 'POST /api/sites/{id}/finance/request-approval'),
  P('finance_approve', ['supervisor', 'business_admin'], 'POST /api/sites/{id}/finance/approve; /api/business-admin/finance-approvals/{id}/approve'),
  P('legal_finalize_dd', ['supervisor'], "POST /api/legal/{id}/dd/finalize (module legal)"),
  P('legal_raise_change_request', ['executive', 'supervisor'], 'POST /api/bd/change-requests'),
  P('legal_approve_change_request', ['supervisor'], "POST /api/legal/change-requests/{id}/approve (module legal)"),
  P('design_admin_review', ['business_admin'], 'POST /api/design/{id}/deliverables/{kind}/admin-review'),
  P('design_approve_gfc', ['business_admin'], 'POST /api/design/gfc/{id}'),
  P('pe_approve_budget', ['business_admin'], 'POST /api/project-excellence/{id}/budget/admin-review'),
  P('project_confirm_quality_audit', ['business_admin'], 'POST /api/project/{id}/quality-audit/admin-confirm'),
  P('nso_final_approval', ['supervisor'], "POST /api/nso/{id}/final-approval (module nso)"),
  P('launch_confirm', ['business_admin'], 'POST /api/launch-approvals/{id}/final-confirm'),
  P('launch_site', ['business_admin'], 'POST /api/launch-approvals/{id}/launch'),
  P('fc_finalize', ['business_admin'], 'POST /api/financial-closure/{id}/finalize'),
  P('undo_approval', ['business_admin'], 'POST /api/sites/{id}/reversible-actions/{rid}/undo'),
  P('delete_site', ['business_admin'], 'DELETE /api/business-admin/sites/{id}'),
];

// ---------------------------------------------------------------- loops v5 cannot draw (v2 had them as transitions)
const transitions = [
  { module: 'bd', from: 'draft_submitted|shortlisted|details_submitted|approved|loi_uploaded', to: 'rejected | archived', kind: 'exit', actor: 'supervisor' },
  { module: 'bd', from: 'archived', to: 'archived_from_status', kind: 'revive', actor: 'supervisor' },
  { module: 'bd', from: 'loi_uploaded', to: 'approved', kind: 'sendback', actor: 'supervisor', note: 'wrong LOI file' },
  { module: 'bd', from: 'details_submitted → approved', to: 'details_submitted', kind: 'undo', actor: 'business_admin' },
  { module: 'legal', from: 'legal_review', to: 'legal_rejected', kind: 'sendback', actor: 'legal supervisor', note: 'negative DDR' },
  { module: 'legal', from: 'legal_rejected', to: 'legal_review', kind: 'loop', actor: 'legal supervisor approving a BD change request (or a positive re-finalise)' },
  { module: 'finance_ca', from: 'awaiting_supervisor|awaiting_admin', to: 'pending', kind: 'sendback', actor: 'supervisor|business_admin' },
  { module: 'design', from: 'deliverable submitted', to: 're-upload', kind: 'sendback', actor: 'supervisor' },
  { module: 'design', from: '2d|3d admin review', to: 'supervisor', kind: 'sendback', actor: 'business_admin' },
  { module: 'design', from: 'gfc_pending', to: '3d revision', kind: 'sendback', actor: 'business_admin' },
  { module: 'design', from: 'supervisor/admin 2D-3D decision', to: 'before', kind: 'undo', actor: 'original actor via business_admin undo' },
  { module: 'pex', from: 'pending_supervisor|pending_admin', to: 'rejected → resubmit', kind: 'sendback', actor: 'supervisor|business_admin' },
  { module: 'project', from: 'initialization proposed', to: 'rejected → supervisor finalises', kind: 'sendback', actor: 'executive' },
  { module: 'project', from: 'expected completion / quality audit', to: 'rejected', kind: 'sendback', actor: 'supervisor|business_admin' },
  { module: 'launch_approval', from: 'any verdict', to: 'next tier', kind: 'forward-only', actor: 'creator / supervisor', note: 'a rejection is recorded, never bounces' },
  { module: 'financial_closure', from: 'pending_supervisor|pending_admin', to: 'rejected → resubmit', kind: 'sendback', actor: 'supervisor|business_admin' },
];

// ---------------------------------------------------------------- comparison with the v5 bluetokai seed (computed)
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'from-design/seed-workspaces.json'), 'utf8'));
const v5 = seed.workspaces.bluetokai.manifest.modules;
const condSet = g => (g ? g.conditions.map(c => c.source + ':' + c.outcome).sort() : []);
const jacc = (a, b) => { const A = new Set(a), Bs = new Set(b); const i = [...A].filter(x => Bs.has(x)).length; const u = new Set([...A, ...Bs]).size; return u ? +(i / u).toFixed(2) : 1; };
const rows = modules.map(r => {
  const s = v5.find(m => m.key === r.key);
  if (!s) return { key: r.key, inSeed: false };
  const rStages = r.stages.map(x => x.name), sStages = s.stages.map(x => x.name);
  const sharedStages = rStages.filter(n => sStages.includes(n));
  return {
    key: r.key, inSeed: true,
    name: { seed: s.name, real: r.name, match: s.name === r.name },
    gate: { seed: condSet(s.entry_gate), real: condSet(r.entry_gate), match: JSON.stringify(condSet(s.entry_gate)) === JSON.stringify(condSet(r.entry_gate)), sameSourceModules: JSON.stringify(condSet(s.entry_gate).map(c => c.split(':')[0])) === JSON.stringify(condSet(r.entry_gate).map(c => c.split(':')[0])) },
    supervisorOnly: { seed: !s.tiers.executive, real: !r.tiers.executive, match: !s.tiers.executive === !r.tiers.executive },
    businessAdminSignoff: { seed: s.tiers.business_admin_signoff, real: r.tiers.business_admin_signoff, match: s.tiers.business_admin_signoff === r.tiers.business_admin_signoff },
    exit: { seed: s.exit_signal, real: r.exit_signal, match: s.exit_signal === r.exit_signal },
    stages: { seed: sStages, real: rStages, sameNames: sharedStages, onlyInSeed: sStages.filter(n => !rStages.includes(n)), onlyInReal: rStages.filter(n => !sStages.includes(n)) },
    approversOnSharedStages: sharedStages.map(n => { const a = s.stages.find(x => x.name === n).approvers, b = r.stages.find(x => x.name === n).approvers; return { stage: n, seed: a, real: b, match: JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()) }; }),
    fieldKeyJaccard: jacc(s.stages.flatMap(x => x.fields.map(f => f.key)), r.stages.flatMap(x => x.fields.map(f => f.key))),
    navLabels: { seed: s.navigation.flatMap(x => x.items.map(i => i.label)), real: r.navigation.flatMap(x => x.items.map(i => i.label)) },
    navRoleDiffs: (() => { const si = s.navigation.flatMap(x => x.items), ri = r.navigation.flatMap(x => x.items); return si.filter(i => ri.some(j => j.label === i.label && JSON.stringify([...j.roles].sort()) !== JSON.stringify([...i.roles].sort()))).map(i => ({ label: i.label, seed: i.roles, real: ri.find(j => j.label === i.label).roles })); })(),
  };
});
const inSeedOnly = v5.filter(m => !modules.some(r => r.key === m.key)).map(m => m.key);
const summary = {
  modulesInBoth: rows.filter(r => r.inSeed).length, modulesOnlyInReal: rows.filter(r => !r.inSeed).map(r => r.key), modulesOnlyInSeed: inSeedOnly,
  namesMatch: rows.filter(r => r.inSeed && r.name.match).length,
  gatesMatch: rows.filter(r => r.inSeed && r.gate.match).map(r => r.key),
  gatesDiffer: rows.filter(r => r.inSeed && !r.gate.match).map(r => r.key),
  gatesDifferOnlyInOutcomeToken: rows.filter(r => r.inSeed && !r.gate.match && r.gate.sameSourceModules).map(r => r.key),
  supervisorOnlyMatch: rows.filter(r => r.inSeed && r.supervisorOnly.match).length,
  exitMatch: rows.filter(r => r.inSeed && r.exit.match).length,
  stageCount: { seed: v5.reduce((a, m) => a + m.stages.length, 0), real: modules.reduce((a, m) => a + m.stages.length, 0) },
  stagesWithSameName: rows.reduce((a, r) => a + (r.inSeed ? r.stages.sameNames.length : 0), 0),
  approverMatchesOnSharedStages: rows.reduce((a, r) => a + (r.inSeed ? r.approversOnSharedStages.filter(x => x.match).length : 0), 0),
  meanFieldKeyJaccard: +(rows.filter(r => r.inSeed).reduce((a, r) => a + r.fieldKeyJaccard, 0) / rows.filter(r => r.inSeed).length).toFixed(2),
};

const flow = {
  $comment: 'The production Matrix-bd (Blue Tokai) retail-expansion flow as configurator data. Modules are v5-manifest-shaped (strip "x-*" keys → validates against from-design/manifest.schema.json); "x-matrix" carries the real-system facts. Generated by scripts/build-matrix-bd-flow.mjs — edit the script, not this file.',
  provenance: { repo: '/Users/aditya/Desktop/bd/Matrix-bd', ref: 'origin/main', sha: SHA, commitDate: '2026-09-17', readMethod: 'git show <sha>:<path> (read-only)', status: 'verified from source; v5-outcome mapping and stage boundaries are an INTERPRETATION (see x-matrix.realState)', outcomeMapping: 'Real statuses are mapped onto v5 OUTCOMES: capture → submitted, allocation → allocated, forwarded/ongoing → in progress | submitted, approval → approved, terminal hand-off → done. The real status lives in x-matrix.realState.' },
  workspace: { id: 'bluetokai', name: 'Blue Tokai (production Matrix-bd)', slug: 'bluetokai' },
  roles: ['business_admin', 'observer', 'supervisor', 'executive'],
  modules,
  permissions,
  'x-matrix': {
    nameSource: 'Module display names follow the backend process-flow blocks (backend/app/services/site_stage_status_service.py _build_stage_blocks: Legal & Compliance, CA / Commercial Code, Design / Technical, Project Excellence, Project Execution, NSO) and module docstrings (Launch Approval, Financial Closure).',
    transitions,
    siteLifecycle: 'see modules-and-vocabularies.json#/siteStateMachine',
    stageLevelGates: modules.flatMap(m => m.stages.filter(s => s['x-matrix'] && s['x-matrix'].stageGate).map(s => ({ module: m.key, stage: s.name, gate: s['x-matrix'].stageGate }))),
    orchestrationToday: 'Inter-module order is stated in four places that must agree by hand: state_machine.py ALLOWED_TRANSITIONS (+ frontend/src/lib/stateMachine.js mirror), workflow_unlocks.py, per-service _assert_*_unlocked guards, and the sites.* mirror columns (docs/14-dynamic-platform/dynamic-flow-transformation-plan.html §2).',
  },
  comparisonWithV5Seed: { summary, modules: rows },
};
fs.writeFileSync(path.join(ROOT, 'from-matrix-bd/matrix-bd-flow.json'), JSON.stringify(flow, null, 2) + '\n');
console.log('wrote from-matrix-bd/matrix-bd-flow.json');
console.log(JSON.stringify(summary, null, 1));
