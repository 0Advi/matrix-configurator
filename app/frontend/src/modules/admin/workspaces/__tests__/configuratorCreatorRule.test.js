// G3 #3: the in-app configurator copy (public/configurator/configurator.dc.html) lets a designer mark
// a stage "Only the site's creator can do this". The rule must round-trip: wizard -> v5 state
// (stage.creatorOnly) -> JSON (what /cfg/state persists) -> manifest() (`restricted_to: 'site_creator'`),
// and be editable afterwards from the inspector. The design file's logic class is evaluated here with a
// minimal stand-in for the dc-runtime base class (synchronous setState), the same way v5 runs it.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, '../../../../../public/configurator/configurator.dc.html');
const html = fs.readFileSync(FILE, 'utf8');

function loadComponent() {
  const start = html.indexOf('class Component extends DCLogic {');
  const end = html.indexOf('</script>', start);
  const code = html.slice(start, end);
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(u, cb) { const patch = typeof u === 'function' ? u(this.state) : u; this.state = { ...this.state, ...patch }; if (cb) cb(); }
    forceUpdate() {}
  }
  const React = { createRef: () => ({ current: null }) };
  return new Function('DCLogic', 'React', 'localStorage', `${code}\nreturn Component;`)(DCLogic, React, { getItem: () => null, setItem: () => {} });
}

describe('configurator copy — "Only the site\'s creator can do this"', () => {
  beforeAll(() => { vi.useFakeTimers(); });
  afterAll(() => { vi.useRealTimers(); });

  it('the template has the per-stage control in the wizard and in the inspector', () => {
    const toggles = html.match(/data-g3="creator-toggle"/g) || [];
    expect(toggles).toHaveLength(2);
    expect(html).toContain('Only the site’s creator can do this</button>');
  });

  it('round-trips wizard -> v5 state -> JSON -> manifest, and toggles off from the inspector', () => {
    const Component = loadComponent();
    const c = new Component({ startWorkspace: 'bluetokai', skipPicker: true });
    c.openWizard('vendor');
    expect(c.wizVals().wizStages[0].creatorCheck).toBe('');
    c.wizVals().wizStages[0].onCreator();
    expect(c.state.wizard.stages[0].creatorOnly).toBe(true);
    expect(c.wizVals().wizStages[0].creatorCheck).toBe('✓');
    expect(c.wizManifest(c.state.wizard).stages[0].restricted_to).toBe('site_creator');
    expect(c.wizManifest(c.state.wizard).stages[1].restricted_to).toBeUndefined();
    c.wizSave();
    const mod = c.state.modules.find((m) => m.key === 'vendor_onboarding');
    expect(mod.stages[0].creatorOnly).toBe(true);
    // what the sync engine stores: plain JSON, nothing stripped
    const persisted = JSON.parse(JSON.stringify(c.state.modules)).find((m) => m.key === 'vendor_onboarding');
    expect(persisted.stages[0].creatorOnly).toBe(true);
    const out = c.manifest().modules.find((m) => m.key === 'vendor_onboarding');
    expect(out.stages[0].restricted_to).toBe('site_creator');
    expect(out.stages[1]).not.toHaveProperty('restricted_to');
    // built-ins never carry the rule (their stages are descriptive)
    expect(c.manifest().modules.filter((m) => m.type === 'builtin').flatMap((m) => m.stages).some((s) => 'restricted_to' in s)).toBe(false);
    // pretend this draft is live, then flip the rule: the publish diff names it
    c.setState({ live: { ...c.state.live, modules: JSON.parse(JSON.stringify(c.state.modules)) } });
    // inspector: toggle it off again (an ordinary, undoable edit)
    c.toggleStageCreator('vendor_onboarding', 0);
    expect(c.diffList().some((d) => d.tag === 'creator rule' && /anyone in the tier/.test(d.text))).toBe(true);
    expect(c.manifest().modules.find((m) => m.key === 'vendor_onboarding').stages[0]).not.toHaveProperty('restricted_to');
    c.toggleStageCreator('vendor_onboarding', 1);
    expect(c.manifest().modules.find((m) => m.key === 'vendor_onboarding').stages[1].restricted_to).toBe('site_creator');
  });
});
