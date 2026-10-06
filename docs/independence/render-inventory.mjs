#!/usr/bin/env node
// Renders inventory.json → INVENTORY.md (grouped by area, with disposition counts). Zero dependencies.
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const inv = JSON.parse(fs.readFileSync(here + 'inventory.json', 'utf8'));
const AREAS = {
  'matrix-bd-backend': 'A. Matrix-bd backend (routes + services)',
  'matrix-bd-db': 'B. Matrix-bd database',
  'matrix-bd-frontend': 'C. Matrix-bd frontend',
  'matrix-bd-misc': 'D. Other Matrix-bd material',
  'our-generic-layer': 'E. Generic layer written in this project',
  'licence-risk': 'F. Licence-risk and third-party items',
  'assumption': 'G. Matrix-bd assumptions baked into the generic layer',
};
const esc = s => String(s ?? '').replace(/\|/g, '\\|');
const count = {};
for (const i of inv.items) count[i.disposition] = (count[i.disposition] || 0) + 1;
let md = `# Independence inventory\n\n_Generated from \`inventory.json\` by \`render-inventory.mjs\` — edit the JSON, not this file._\n\n`;
md += `As of ${inv.as_of} · repo \`${inv.repo_commit}\` · baseline tag \`${inv.baseline_tag}\` · **${inv.items.length} items**: `;
md += Object.entries(count).map(([k, v]) => `${v} ${k}`).join(' · ') + '\n\n';
md += '| Disposition | Meaning |\n|---|---|\n' + Object.entries(inv.dispositions).map(([k, v]) => `| \`${k}\` | ${esc(v)} |`).join('\n') + '\n\n';
for (const [area, title] of Object.entries(AREAS)) {
  const items = inv.items.filter(i => i.area === area);
  if (!items.length) continue;
  md += `## ${title}\n\n| ID | What | Where | Origin | Disposition | Target | Notes |\n|---|---|---|---|---|---|---|\n`;
  for (const i of items) md += `| ${i.id} | ${esc(i.what)} | ${esc(i.path)} | ${esc(i.origin)} | **${i.disposition}** | ${esc(i.target)} | ${esc(i.notes)} |\n`;
  md += '\n';
}
fs.writeFileSync(here + 'INVENTORY.md', md);
console.log(`INVENTORY.md: ${inv.items.length} items`);
