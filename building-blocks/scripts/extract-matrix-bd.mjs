#!/usr/bin/env node
// Regenerates the machine-derivable Matrix-bd blocks:
//   from-matrix-bd/modules-and-vocabularies.json  (CHECK vocabularies, site FSM, module lists)
//   from-matrix-bd/route-guards.json              (every route → roles / module guard)
//   from-matrix-bd/zm-tokens.json                 (--zm-* design tokens)
//
// STRICTLY READ-ONLY against the Matrix-bd repo: every byte is read through
// `git -C <repo> show <sha>:<path>` / `git ls-tree` with GIT_OPTIONAL_LOCKS=0
// (no checkout, no fetch, no index refresh, no working-tree reads).
//
//   node scripts/extract-matrix-bd.mjs [repoPath] [ref=origin/main]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../from-matrix-bd');
const REPO = process.argv[2] || '/Users/aditya/Desktop/bd/Matrix-bd';
const REF = process.argv[3] || 'origin/main';
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 });

const SHA = git('rev-parse', REF).trim();
const COMMIT = git('show', '-s', '--format=%ci %s', SHA).trim();
const show = p => git('show', `${SHA}:${p}`);
const lsTree = dir => git('ls-tree', '-r', '--name-only', SHA, dir).split('\n').filter(Boolean);
const PROV = { repo: REPO, ref: REF, sha: SHA, commit: COMMIT, readMethod: 'git show <sha>:<path> (read-only, GIT_OPTIONAL_LOCKS=0)', generatedBy: 'building-blocks/scripts/extract-matrix-bd.mjs' };
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ SQL CHECK vocabularies
const stripSqlComments = s => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
function balanced(s, openIdx) { // s[openIdx] === '('
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return s.slice(openIdx + 1);
}
const inLists = body => [...body.matchAll(/(\w+)\s+IN\s*\(\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)\s*\)/gi)]
  .map(m => ({ column: m[1].toLowerCase(), values: [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map(x => x[1]) }));

/** Parse one SQL file into ordered events: {op:'add'|'drop'|'droptable', table, name?, column?, values?} */
function sqlEvents(sql) {
  const events = [];
  const text = stripSqlComments(sql);
  for (const stmt of text.split(';')) {
    const t = /(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:public\.)?"?(\w+)"?/i.exec(stmt);
    if (!t) continue;
    const table = t[2].toLowerCase();
    if (/^DROP/i.test(t[1])) { events.push({ op: 'droptable', table }); continue; }
    for (const d of stmt.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) events.push({ op: 'drop', table, name: d[1].toLowerCase() });
    const re = /CHECK\s*\(/gi; let m;
    while ((m = re.exec(stmt))) {
      const body = balanced(stmt, m.index + m[0].length - 1);
      const before = stmt.slice(Math.max(0, m.index - 120), m.index);
      const named = /CONSTRAINT\s+"?(\w+)"?\s*$/i.exec(before);
      const colDef = /(?:^|,|\()\s*"?(\w+)"?\s+[a-z][\w ()]*?(?:NOT NULL|DEFAULT [^,]*?|\s)*$/i.exec(before);
      for (const l of inLists(body)) {
        const name = named ? named[1].toLowerCase() : `${table}_${l.column}_check`;
        events.push({ op: 'add', table, name, column: l.column, values: l.values, inline: !named && !!colDef });
      }
    }
  }
  return events;
}

const schemaSqlPath = 'backend/database/schema.sql';
const migrationPaths = lsTree('backend/database/migrations/').filter(p => p.endsWith('.sql')).sort();
const schemaEvents = sqlEvents(show(schemaSqlPath));
const schemaVocab = {};
for (const e of schemaEvents) if (e.op === 'add') (schemaVocab[`${e.table}.${e.column}`] = schemaVocab[`${e.table}.${e.column}`] || []).push({ constraint: e.name, values: e.values });

// Simulate migrations in filename order: constraint name → {column, values}; DROP removes.
const live = {}; // table -> name -> {column, values, source}
const touched = new Set();
for (const p of migrationPaths) {
  for (const e of sqlEvents(show(p))) {
    if (e.op === 'droptable') { delete live[e.table]; continue; }
    live[e.table] = live[e.table] || {};
    if (e.op === 'drop') { delete live[e.table][e.name]; continue; }
    live[e.table][e.name] = { column: e.column, values: e.values, source: p };
    touched.add(`${e.table}.${e.column}`);
  }
}

// ORM CheckConstraints (backend/app/db/models.py)
const modelsSrc = show('backend/app/db/models.py');
const ormVocab = {};
for (const block of modelsSrc.split(/\nclass /).slice(1)) {
  const tn = /__tablename__\s*=\s*"(\w+)"/.exec(block); if (!tn) continue;
  for (const cc of block.matchAll(/CheckConstraint\(\s*"([^"]+)"\s*,\s*name="(\w+)"/g)) {
    for (const l of inLists(cc[1])) (ormVocab[`${tn[1]}.${l.column}`] = ormVocab[`${tn[1]}.${l.column}`] || []).push({ constraint: cc[2], values: l.values });
  }
}

const keys = new Set([...Object.keys(schemaVocab), ...touched, ...Object.keys(ormVocab)]);
const intersect = lists => lists.reduce((acc, l) => acc === null ? l.slice() : acc.filter(v => l.includes(v)), null) || [];
const vocabularies = {};
for (const k of [...keys].sort()) {
  const [table, column] = k.split('.');
  const migConstraints = Object.entries(live[table] || {}).filter(([, c]) => c.column === column).map(([name, c]) => ({ constraint: name, values: c.values, source: c.source }));
  const schemaList = schemaVocab[k] || [];
  const effective = migConstraints.length ? intersect(migConstraints.map(c => c.values)) : (schemaList.length ? intersect(schemaList.map(c => c.values)) : intersect((ormVocab[k] || []).map(c => c.values)));
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  vocabularies[k] = {
    table, column, effective,
    effectiveFrom: migConstraints.length ? 'migrations (simulated in filename order; multiple live CHECKs intersect)' : (schemaList.length ? schemaSqlPath : 'backend/app/db/models.py'),
    migrations: migConstraints,
    schemaSql: schemaList,
    orm: ormVocab[k] || [],
    drift: [
      ...(schemaList.length && !same(intersect(schemaList.map(c => c.values)), effective) ? ['schema.sql differs from effective'] : []),
      ...((ormVocab[k] || []).length && !same(intersect(ormVocab[k].map(c => c.values)), effective) ? ['models.py differs from effective'] : []),
    ],
  };
}

// ------------------------------------------------------------------ site state machine
const smSrc = show('backend/app/domain/state_machine.py');
const enumVals = Object.fromEntries([...smSrc.matchAll(/^\s+(\w+)\s*=\s*"(\w+)"/gm)].map(m => [m[1], m[2]]));
const allowed = smSrc.slice(smSrc.indexOf('ALLOWED_TRANSITIONS'));
const transitions = {};
for (const m of allowed.matchAll(/SiteStatus\.(\w+):\s*\[([^\]]*)\]/g)) transitions[enumVals[m[1]]] = [...m[2].matchAll(/SiteStatus\.(\w+)/g)].map(x => enumVals[x[1]]);

// ------------------------------------------------------------------ mirror vocabularies documented in code (no CHECK)
const MIRRORS = {
  'sites.status': { values: Object.values(enumVals), source: 'backend/app/domain/state_machine.py (SiteStatus) — DB CHECK chk_sites_status lists only the first 7 and is NOT VALID' },
  'sites.legal_dd_status': { values: ['pending', 'in_review', 'positive', 'negative'], source: 'backend/app/services/legal_service.py module docstring', writer: 'legal' },
  'sites.agreement_status': { values: ['pending', 'signed', 'registered'], source: 'backend/app/services/legal_service.py module docstring', writer: 'legal' },
  'sites.licensing_status': { values: ['pending', 'partial', 'complete'], source: 'backend/app/services/legal_service.py module docstring', writer: 'legal' },
  'sites.finance_status': { values: ['pending', 'awaiting_supervisor', 'awaiting_admin', 'approved'], source: 'backend/app/services/finance_service.py _FINANCE_STATUS_ORDER', writer: 'finance (BD site tracker)' },
  'sites.design_status': { values: ['pending', 'allocated', 'in_progress', 'gfc_pending', 'approved', 'rejected'], source: 'backend/app/db/models.py Site.design_status comment; design_service.py docstring', writer: 'design' },
  'sites.project_status': { values: ['pending', 'allocated', 'in_progress', 'done'], source: 'backend/app/db/models.py ProjectReview chk_project_status (schema.sql also lists budgeting)', writer: 'project' },
  'sites.project_excellence_status': { values: ['pending', 'allocated', 'budgeting', 'approved'], source: 'backend/app/services/project_excellence_service.py (svc_allocate_pe, svc_save_pe_budget, svc_admin_review_pe_budget)', writer: 'project_excellence' },
  'sites.financial_closure_status': { values: ['pending', 'open', 'allocated', 'budgeting', 'closed'], source: 'backend/app/services/financial_closure_service.py (svc_send_for_financial_closure, svc_allocate_fc, svc_save_fc_budget, svc_admin_finalize_fc)', writer: 'financial_closure' },
  'sites.is_launched': { values: [true, false], source: 'backend/app/db/models.py Site.is_launched', writer: 'launch_approval' },
};

const MODULE_LISTS = {
  membershipModules: vocabularies['user_module_memberships.module']?.effective,
  delegationModules: vocabularies['site_delegations.module']?.effective,
  moduleCodeModules: vocabularies['module_codes.module']?.effective,
  supervisorInviteModules: vocabularies['supervisor_invite_codes.module']?.effective,
  note: 'A "module" in Matrix-bd conflates org unit (membership), permission scope (require_module), UI area and pipeline stage. financial_closure and quality_audit exist only as site_delegations scopes (no membership); finance/CA has no module at all (BD site tracker + business-admin portal); launch_approval has no module (business_admin + site creator + supervisor). payment is retired (202606132) but survives in module_codes.',
};

write('modules-and-vocabularies.json', {
  $comment: 'Generated by scripts/extract-matrix-bd.mjs from Matrix-bd at the pinned SHA. CHECK vocabularies are parsed from SQL; mirrors are transcribed from code with source refs.',
  provenance: PROV,
  modules: MODULE_LISTS,
  siteStateMachine: { source: 'backend/app/domain/state_machine.py', statuses: Object.values(enumVals), transitions, terminal: Object.entries(transitions).filter(([, v]) => !v.length).map(([k]) => k) },
  mirrorColumns: MIRRORS,
  checkVocabularies: vocabularies,
  stats: { migrationFiles: migrationPaths.length, checkVocabularyColumns: Object.keys(vocabularies).length, columnsWithDrift: Object.values(vocabularies).filter(v => v.drift.length).length },
});

// ------------------------------------------------------------------ route guards (python AST helper)
const routes = JSON.parse(execFileSync('python3', [path.join(HERE, 'route_guards.py'), REPO, SHA], { env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 }));
write('route-guards.json', {
  $comment: 'Every FastAPI route with its require_role / require_real_role / require_module guards (resolved through module-level Annotated aliases). business_admin and observer bypass require_role/require_module (READ_ALL_ROLES); observer is refused on every non-GET in get_current_user. Generated by scripts/route_guards.py.',
  provenance: Object.assign({}, PROV, { generatedBy: 'building-blocks/scripts/route_guards.py via extract-matrix-bd.mjs' }),
  count: routes.routes.length,
  routes: routes.routes,
});

// ------------------------------------------------------------------ zm tokens
function cssBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const props = {};
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i < 0) continue; const k = d.slice(0, i).trim(); if (k.startsWith('--')) props[k] = d.slice(i + 1).trim().replace(/\s+/g, ' '); }
    // the captured prefix may carry a preceding @import …; — keep only the real selector
    if (Object.keys(props).length) out.push({ selector: m[1].split(/[;}]/).pop().trim(), props });
  }
  return out;
}
const appCssPath = 'frontend/public/colors_and_type.css';
const dsCssPath = 'z-matrix-design-system/project/colors_and_type.css';
const app = cssBlocks(show(appCssPath)), ds = cssBlocks(show(dsCssPath));
const merge = (blocks, sel) => Object.assign({}, ...blocks.filter(b => b.selector === sel).map(b => b.props));
const light = merge(app, ':root'), dark = merge(app, '[data-theme="dark"]');
const dsLight = merge(ds, ':root'), dsDark = merge(ds, '[data-theme="dark"]');
const norm = v => (v === undefined ? undefined : String(v).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim());
const diff = (a, b) => Object.keys({ ...a, ...b }).filter(k => norm(a[k]) !== norm(b[k])).map(k => ({ token: k, app: a[k] ?? null, designSystem: b[k] ?? null }));
const group = props => {
  const g = {};
  for (const [k, v] of Object.entries(props)) {
    const name = k.replace(/^--zm-/, '');
    const cat = /^(font|fs|lh|tracking)/.test(name) ? 'type' : /^(radius|r-)/.test(name) ? 'radius' : /^(shadow|glass|ring)/.test(name) ? 'elevation' : /^(space|gap|pad|s-\d)/.test(name) ? 'space' : /^(ease|dur)/.test(name) ? 'motion' : 'color';
    (g[cat] = g[cat] || {})[k] = v;
  }
  return g;
};
write('zm-tokens.json', {
  $comment: 'Z-Matrix design system tokens (--zm-*) as shipped by the Matrix-bd frontend. Two themes: :root = "Peach Skyline" (light, default), [data-theme="dark"] = "Deep Obsidian".',
  provenance: Object.assign({}, PROV, { files: [appCssPath, dsCssPath] }),
  themes: { light: group(light), dark: group(dark) },
  counts: { light: Object.keys(light).length, dark: Object.keys(dark).length },
  driftVsDesignSystemPackage: { light: diff(light, dsLight), dark: diff(dark, dsDark), note: `${appCssPath} (shipped) vs ${dsCssPath} (design-system source); most differences in the raw files are whitespace only — listed here are VALUE differences.` },
});

console.log(`Matrix-bd @ ${SHA.slice(0, 12)} (${COMMIT})`);
console.log(`  ${Object.keys(vocabularies).length} CHECK vocabularies, ${routes.routes.length} routes, ${Object.keys(light).length}/${Object.keys(dark).length} zm tokens (light/dark)`);
