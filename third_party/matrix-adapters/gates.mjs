// Gate conditions for the Matrix module runtime — JS twin of gates.py (first-party glue).
// Compiles configurator gates / roll-ups to the "matrix-gate/1" JsonLogic dialect and evaluates
// them with the vendored json-logic-js 2.0.5 (MIT, third_party/json-logic-js). Output must stay
// byte-identical to gates.py — test/test_gates.py checks both on every real gate.
// See gates.py for the case-facts contract and the accepted condition forms.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// F4: in the Vite app use `import jsonLogic from 'json-logic-js'` (npm json-logic-js@2.0.5, same bytes).
const jsonLogic = require('../json-logic-js/logic.js');

export const DIALECT = 'matrix-gate/1';
export const ALLOWED_OPS = new Set(['and', 'or', '!', '!!', 'if', '===', '!==', '<', '<=', '>', '>=',
  'in', 'var', 'missing', 'missing_some', 'all', 'some', 'none', 'filter', 'reduce', '+']);
export const FIELD_OPS = new Set(['===', '!==', '<', '<=', '>', '>=', 'in']);
export const BINARY_OPS = new Set(['===', '!==', '<', '<=', '>', '>=']);
const isNumber = x => typeof x === 'number';
const mixesBoolNumber = args => args.some(a => typeof a === 'boolean') && args.some(isNumber);
export const YES = ['yes', 'true', 'done', 'ready'];
export const NO = ['no', 'false', 'blocked'];
export const NA = ['n/a', 'na'];

export class GateError extends Error {}

function parts(c) {
  const src = c.source ?? c.src;
  if (typeof src !== 'string' || !src) throw new GateError(`condition without a source: ${JSON.stringify(c)}`);
  return { src, out: c.outcome ?? c.out, stage: c.stage, field: c.field, op: c.op ?? '===', value: c.value };
}

export function compileCondition(c) {
  const p = parts(c);
  if (p.field !== undefined && p.field !== null) {
    if (!FIELD_OPS.has(p.op)) throw new GateError(`field op ${p.op} not allowed`);
    return { [p.op]: [{ var: `fields.${p.src}.${p.field}` }, p.value ?? null] };
  }
  if (p.stage !== undefined && p.stage !== null) {
    if (!Number.isInteger(p.stage)) throw new GateError(`stage must be the stage order (int): ${JSON.stringify(c)}`);
    return { in: [p.stage, { var: [`stages.${p.src}`, []] }] };
  }
  if (typeof p.out !== 'string' || !p.out) throw new GateError(`condition without an outcome: ${JSON.stringify(c)}`);
  return { in: [p.out, { var: [`reached.${p.src}`, []] }] };
}

const condsOf = gate => (gate ? (gate.conditions ?? gate.conds ?? []) : []);

export function compileGate(gate) {
  const conds = condsOf(gate);
  if (!conds.length) return null;
  const match = gate.match ?? 'all';
  if (match !== 'all' && match !== 'any') throw new GateError(`match must be 'all' or 'any', got ${match}`);
  return { '!!': [{ [match === 'all' ? 'and' : 'or']: conds.map(compileCondition) }] };
}

export function compileRollup(rollup) {
  const r = rollup || {};
  const strategy = r.strategy ?? 'all_positive';
  const checks = { var: ['checks', []] };
  const anyNo = { some: [checks, { in: [{ var: '' }, NO] }] };
  const allYesNa = { all: [checks, { in: [{ var: '' }, [...YES, ...NA]] }] };
  if (strategy === 'custom') return 'pending_engineering';
  if (strategy === 'all_positive' || strategy === 'any_negative') return { if: [anyNo, 'rejected', allYesNa, 'approved', 'pending'] };
  if (strategy === 'count_at_least') {
    const n = parseInt(r.n || 0, 10) || 0;
    const yesCount = { reduce: [checks, { '+': [{ var: 'accumulator' }, { if: [{ in: [{ var: 'current' }, YES] }, 1, 0] }] }, 0] };
    const allAnswered = { none: [checks, { '!': [{ var: '' }] }] };
    return { if: [{ '>=': [yesCount, n] }, 'approved', allAnswered, 'rejected', 'pending'] };
  }
  if (strategy === 'sum_under') {
    const limit = Number(String(r.limit ?? '').replace(/[^0-9.]/g, '')) || 0;
    const s = { var: 'sum' };
    return { if: [{ in: [s, [null, '']] }, 'pending', { '<': [s, limit] }, 'approved', 'rejected'] };
  }
  throw new GateError(`unknown roll-up strategy ${strategy}`);
}

export function lint(rule, path = '$') {
  const problems = [];
  if (Array.isArray(rule)) rule.forEach((x, i) => problems.push(...lint(x, `${path}[${i}]`)));
  else if (rule && typeof rule === 'object') {
    const keys = Object.keys(rule);
    if (keys.length !== 1) return [`${path}: an operation object must have exactly one key`];
    const op = keys[0], args = rule[op];
    if (!ALLOWED_OPS.has(op)) problems.push(`${path}: operator '${op}' is not in ${DIALECT}`);
    // Each rule below closes a JS/Python divergence found by test/test_differential.py.
    if (BINARY_OPS.has(op) && !(Array.isArray(args) && args.length === 2)) problems.push(`${path}: '${op}' takes exactly 2 arguments in ${DIALECT}`);
    if ((op === '===' || op === '!==') && Array.isArray(args) && args.length === 2 && mixesBoolNumber(args)) {
      problems.push(`${path}: '${op}' between a boolean and a number literal (Python treats 1 == True)`);
    }
    if (op === '+') {
      if (!(Array.isArray(args) && args.length === 2)) problems.push(`${path}: '+' takes exactly 2 arguments in ${DIALECT}`);
      else if (args.some(a => typeof a === 'boolean' || a === null || typeof a === 'string')) {
        problems.push(`${path}: '+' operands must be numbers or rules, not bool/null/string literals`);
      }
    }
    if (op === 'reduce' && !(Array.isArray(args) && args.length === 3 && isNumber(args[2]))) {
      problems.push(`${path}: 'reduce' needs 3 arguments with a number literal as the initial value`);
    }
    if (op === 'in' && Array.isArray(args) && Array.isArray(args[1]) &&
        args[1].some(h => typeof h === 'boolean' || (typeof h === 'number' && !Number.isInteger(h)))) {
      problems.push(`${path}: 'in' haystack literals must be strings, ints or null`);
    }
    problems.push(...lint(args, `${path}.${op}`));
  } else if (typeof rule === 'number' && Number.isNaN(rule)) problems.push(`${path}: NaN literal`);
  return problems;
}

export function evaluate(rule, facts) { return rule === null || rule === undefined ? true : jsonLogic.apply(rule, facts); }

export function checkGate(gate, facts) {
  const rule = compileGate(gate);
  if (rule === null) return { open: true, refusal: null, unmet: [] };
  const open = !!evaluate(rule, facts);
  const unmet = condsOf(gate).filter(c => !evaluate(compileCondition(c), facts));
  return { open, refusal: open ? null : (gate.refusal_message || gate.refusal || 'Locked.'), unmet };
}

export function rollupVerdict(rollup, checks, sum = null) {
  return evaluate(compileRollup(rollup), { checks: checks.map(x => String(x).trim().toLowerCase()), sum });
}

export function compileManifest(manifest) {
  const out = { dialect: DIALECT, modules: {} };
  for (const m of manifest.modules || []) {
    const stageGates = {};
    for (const s of m.stages || []) if (s.gate) stageGates[String(s.order)] = compileGate(s.gate);
    out.modules[m.key] = { entry_gate: compileGate(m.entry_gate), rollup: compileRollup(m.rollup), stage_gates: stageGates };
  }
  return out;
}
