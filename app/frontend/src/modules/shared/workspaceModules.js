// skipcq: JS-0833
// The modules a workspace-access session can be pointed at, and where each one
// lands.
//
// Shared because two surfaces drive the same override: the Workspace Access
// panel in the portals, and the read-only banner's module switcher in the app
// chrome. They were one list copied into two files for about an hour, which is
// exactly how a module gets added to one switcher and not the other.
//
// `value` matches the backend module claim (X-Override-Module), so it must stay
// in step with app/domain/schemas/business_admin.py's Module literal.
//
// F4b: this list is now the FALLBACK (a legacy tenant, or before GET
// /workspace/modules has answered). The live list comes from the tenant's
// published release via useWorkspaceModules() — see switcherModules() below —
// which adds configurator-defined (custom) modules, drops disabled ones and
// follows the release's order and labels.
export const WORKSPACE_MODULES = [
  { value: 'bd',                  label: 'BD',                  route: '/' },
  { value: 'legal',               label: 'Legal',               route: '/legal' },
  { value: 'design',              label: 'Design',              route: '/design' },
  { value: 'project_excellence',  label: 'Project Excellence',  route: '/project-excellence' },
  { value: 'project',             label: 'Project',             route: '/project' },
  { value: 'nso',                 label: 'NSO',                 route: '/nso' },
];

// Every built-in module key of the app's catalog (docs/F4-API.md §0). Anything else that
// passes the key rule is a configurator-defined module served by the generic runtime.
export const BUILTIN_MODULE_KEYS = [
  'bd', 'legal', 'finance_ca', 'design', 'project_excellence', 'project', 'nso',
  'launch_approval', 'financial_closure',
];
const BUILTIN = new Set(BUILTIN_MODULE_KEYS);
const MODULE_KEY_RE = /^[a-z][a-z0-9_]{1,38}$/;
// Keys the backend reserves (never a module) — mirrors module_registry_service.
const RESERVED = new Set(['admin', 'api', 'new', 'site', 'sites', 'user', 'users', 'module', 'modules',
  'settings', 'auth', 'report', 'reports']);

/** A configurator-defined module key (not a built-in, valid shape). */
export function isCustomModuleKey(key) {
  return typeof key === 'string' && MODULE_KEY_RE.test(key) && !BUILTIN.has(key) && !RESERVED.has(key);
}

/** The generic module page for a custom module (HashRouter: /#/m/<key>). */
export function customModuleRoute(key) {
  return `/m/${encodeURIComponent(key)}`;
}

export function workspaceModule(value, modules = WORKSPACE_MODULES) {
  return modules.find((m) => m.value === value)
    || WORKSPACE_MODULES.find((m) => m.value === value)
    || null;
}

// A label only for a module we actually know (static list or the tenant's release) — never
// a raw key, so an unknown slug is left out of copy rather than printed.
export function workspaceModuleLabel(value, modules) {
  return workspaceModule(value, modules)?.label || null;
}

// Where entering `module` should land. Falls back to the app root rather than
// throwing, so an unrecognised claim degrades to the overview instead of a
// blank screen. A custom-module key not (yet) in the list still lands on its page.
export function workspaceModuleRoute(value, modules) {
  return workspaceModule(value, modules)?.route || (isCustomModuleKey(value) ? customModuleRoute(value) : '/');
}

/**
 * The modules a switcher should offer, from GET /workspace/modules (`apiModules`, already
 * enabled-only and ordered by the release's `position`): every module with teams
 * (`has_membership`) — the built-in departments plus custom modules — as
 * {value, label, route, kind, supervisorOnly}. Built-ins keep their bespoke page route;
 * custom modules route to /m/<key>. Without an API answer: the static fallback above.
 */
export function switcherModules(apiModules) {
  if (!Array.isArray(apiModules) || apiModules.length === 0) return WORKSPACE_MODULES;
  const out = apiModules
    .filter((m) => m && m.has_membership !== false)
    .map((m) => {
      const fallback = WORKSPACE_MODULES.find((w) => w.value === m.key);
      const custom = m.kind === 'custom' || isCustomModuleKey(m.key);
      return {
        value: m.key,
        // Built-ins keep the short switcher labels people know (BD, NSO…); a custom module
        // has only its configured name.
        label: custom ? (m.label || m.key) : (fallback?.label || m.label || m.key),
        route: custom ? customModuleRoute(m.key) : (fallback?.route || m.route || '/'),
        kind: custom ? 'custom' : 'builtin',
        supervisorOnly: !!m.supervisor_only,
      };
    });
  return out.length ? out : WORKSPACE_MODULES;
}
