#!/usr/bin/env node
// Independence gate: scans a source tree for anything that ties it to Matrix-bd, NocoBase, the
// Claude Design dc-runtime or third-party brands. Run it on the standalone repo before every release:
//
//   node docs/independence/check-independence.mjs [root=.] [--json] [--only=<rule,...>]
//
// Exit code 1 when any "blocker" rule has hits. Zero dependencies (Node 18+).
import fs from 'node:fs';
import path from 'node:path';

export const RULES = [
  // id, severity, what, regex (case-insensitive unless noted), files it applies to
  { id: 'matrix-bd-tables', severity: 'blocker', what: 'Matrix-bd domain tables / site entity',
    re: /\b(public\.)?(sites|site_details|site_files|site_licensing|site_agreement|site_budgets?|site_budget_items|site_delegations|shortlist_delegations|design_deliverables|design_reviews|legal_dd_checklist|legal_change_requests|nso_reviews|launch_approvals|launch_review_events|project_reviews|project_budget_items|project_excellence_items|project_excellence_reviews|quality_audit_reports|stage_events)\b/ },
  { id: 'matrix-bd-modules', severity: 'blocker', what: 'hard-coded Matrix-bd built-in module keys',
    re: /['"`](bd|legal|finance_ca|design|project_excellence|pex|project|nso|launch_approval|financial_closure|payment|quality_audit)['"`]/, code: true },
  { id: 'matrix-bd-status', severity: 'blocker', what: 'Matrix-bd status vocabularies',
    re: /\b(draft_submitted|shortlisted|details_submitted|loi_uploaded|legal_review|pushed_to_payments|gfc_pending|ready_to_launch|pending_admin_final|under_exec_review|legal_dd_status|design_status|project_excellence_status|financial_closure_status)\b/ },
  { id: 'brands', severity: 'blocker', what: 'third-party / customer brand names',
    re: /blue ?tokai|bluetokai|starbucks|burger ?king|\bBT-[A-Z]{3}\b/i },
  { id: 'matrix-name', severity: 'warning', what: 'the "Matrix" product name / Matrix-bd references',
    re: /matrix[-_ ]?bd|zm-tokens|z-matrix|ZM_TOKENS/i },
  { id: 'nocobase', severity: 'blocker', what: 'NocoBase dependency (licence §5.4)',
    re: /nocobase|\bcfg_(workspaces|releases|modules|gates|stages)\b/i },
  { id: 'dc-runtime', severity: 'blocker', what: 'Claude Design dc-runtime / .dc.html artifacts (no licence)',
    re: /dc-runtime|\.dc\.html|support\.js\b|load-dc\.mjs|loadComponent\(/i },
  { id: 'supabase-shape', severity: 'warning', what: 'Supabase-shaped auth/RLS inherited from Matrix-bd',
    re: /supabase|\b(anon|authenticated)\b.*\b(REVOKE|GRANT|ROLE)\b/i },
  { id: 'india-locale', severity: 'warning', what: 'India-specific assumptions (₹, GST, lakh grouping)',
    re: /₹|\bINR\b|\bGST(IN)?\b|lakh|crore|en-IN/ },
  { id: 'fixed-role-ladder', severity: 'warning', what: 'fixed executive < supervisor < business_admin ladder (should come from the manifest)',
    re: /['"](executive|supervisor|business_admin)['"]\s*[,\]]\s*['"](supervisor|business_admin|executive)['"]/ },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', '.pytest_cache']);
const TEXT_EXT = /\.(m?js|jsx|ts|tsx|py|sql|json|md|html|css|ya?ml|toml|sh|txt|env|example)$/i;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && TEXT_EXT.test(e.name) && fs.statSync(p).size < 2_000_000) yield p;
  }
}

export function scan(root, { only, exclude = [] } = {}) {
  const rules = only ? RULES.filter(r => only.includes(r.id)) : RULES;
  const hits = Object.fromEntries(rules.map(r => [r.id, { files: 0, lines: 0, sample: [] }]));
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (exclude.some(x => rel.startsWith(x))) continue;
    const isCode = /\.(m?js|jsx|ts|tsx|py|sql)$/.test(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const r of rules) {
      if (r.code && !isCode) continue;
      let n = 0;
      lines.forEach((l, i) => { if (r.re.test(l)) { n++; if (hits[r.id].sample.length < 3) hits[r.id].sample.push(`${rel}:${i + 1}`); } });
      if (n) { hits[r.id].files++; hits[r.id].lines += n; }
    }
  }
  return rules.map(r => ({ id: r.id, severity: r.severity, what: r.what, ...hits[r.id] }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find(a => !a.startsWith('--')) || '.');
  const only = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  // This folder documents the forbidden identifiers, so it is never scanned.
  const exclude = [path.relative(root, path.dirname(new URL(import.meta.url).pathname))].filter(x => x && !x.startsWith('..'));
  const res = scan(root, { only: only.length ? only : undefined, exclude });
  if (args.includes('--json')) console.log(JSON.stringify(res, null, 1));
  else {
    for (const r of res) console.log(`${r.files ? (r.severity === 'blocker' ? '✗' : '!') : '✓'} ${r.id.padEnd(18)} ${String(r.files).padStart(5)} files ${String(r.lines).padStart(6)} lines  ${r.what}${r.sample.length ? '  e.g. ' + r.sample.join(', ') : ''}`);
  }
  process.exit(res.some(r => r.severity === 'blocker' && r.files) ? 1 : 0);
}
