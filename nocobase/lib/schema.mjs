// Data model for the Workspace Configurator collections (single source of truth for
// provision.mjs and reset.mjs). Mirrors docs/CONTRACT.md -> "NocoBase collections".
//
// Each field is expressed the way NocoBase's collection manager stores it: a storage `type`
// (database column), a UI `interface`, and a `uiSchema` so the admin UI renders it sensibly.

/** @typedef {{ name: string, interface: string, type: string, uiSchema: object, [k: string]: any }} FieldDef */
/** @typedef {{ name: string, title: string, description: string, titleField: string, fields: FieldDef[] }} CollectionDef */

const title = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Single-line text (varchar 255). */
export const string = (name, extra = {}) => ({
  name,
  interface: 'input',
  type: 'string',
  uiSchema: { type: 'string', title: title(name), 'x-component': 'Input' },
  ...extra,
});

/** Long text (Postgres `text`). */
export const text = (name) => ({
  name,
  interface: 'textarea',
  type: 'text',
  uiSchema: { type: 'string', title: title(name), 'x-component': 'Input.TextArea' },
});

/** 32-bit integer (Postgres `integer`, returned as a JS number). */
export const integer = (name) => ({
  name,
  interface: 'integer',
  type: 'integer',
  uiSchema: {
    type: 'number',
    title: title(name),
    'x-component': 'InputNumber',
    'x-component-props': { stringMode: true, step: '1' },
    'x-validator': 'integer',
  },
});

/** Boolean checkbox. */
export const boolean = (name) => ({
  name,
  interface: 'checkbox',
  type: 'boolean',
  uiSchema: { type: 'boolean', title: title(name), 'x-component': 'Checkbox' },
});

/**
 * JSON document. Stored as Postgres `json` (not `jsonb`) on purpose: `json` keeps the text
 * verbatim, so object key order round-trips exactly (jsonb would re-sort keys).
 */
export const json = (name) => ({
  name,
  interface: 'json',
  type: 'json',
  uiSchema: {
    type: 'object',
    title: title(name),
    'x-component': 'Input.JSON',
    'x-component-props': { autoSize: { minRows: 5 } },
  },
});

/**
 * NocoBase "general" template preset fields (what the admin UI adds by default):
 * snowflake `id` primary key + createdAt/createdBy/updatedAt/updatedBy.
 * @returns {FieldDef[]}
 */
export function presetFields() {
  return [
    {
      name: 'id',
      interface: 'snowflakeId',
      type: 'snowflakeId',
      primaryKey: true,
      allowNull: false,
      autoIncrement: false,
      uiSchema: {
        type: 'number',
        title: '{{t("ID")}}',
        'x-component': 'InputNumber',
        'x-component-props': { stringMode: true, separator: '0.00', step: '1' },
        'x-validator': 'integer',
      },
    },
    {
      name: 'createdAt',
      interface: 'createdAt',
      type: 'date',
      field: 'createdAt',
      uiSchema: { type: 'datetime', title: '{{t("Created at")}}', 'x-component': 'DatePicker', 'x-component-props': {}, 'x-read-pretty': true },
    },
    {
      name: 'createdBy',
      interface: 'createdBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'createdById',
      uiSchema: {
        type: 'object',
        title: '{{t("Created by")}}',
        'x-component': 'AssociationField',
        'x-component-props': { fieldNames: { value: 'id', label: 'nickname' } },
        'x-read-pretty': true,
      },
    },
    {
      name: 'updatedAt',
      interface: 'updatedAt',
      type: 'date',
      field: 'updatedAt',
      uiSchema: { type: 'datetime', title: '{{t("Last updated at")}}', 'x-component': 'DatePicker', 'x-component-props': {}, 'x-read-pretty': true },
    },
    {
      name: 'updatedBy',
      interface: 'updatedBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'updatedById',
      uiSchema: {
        type: 'object',
        title: '{{t("Last updated by")}}',
        'x-component': 'AssociationField',
        'x-component-props': { fieldNames: { value: 'id', label: 'nickname' } },
        'x-read-pretty': true,
      },
    },
  ];
}

/** @type {CollectionDef[]} */
export const COLLECTIONS = [
  {
    name: 'cfg_workspaces',
    title: 'Configurator · Workspaces',
    description: 'Per-workspace configurator document (authoritative). Keyed by unique slug.',
    titleField: 'name',
    fields: [
      string('slug', { unique: true, allowNull: false, uiSchema: { type: 'string', title: 'Slug', 'x-component': 'Input', required: true } }),
      string('name'),
      string('initials'),
      boolean('is_custom'),
      integer('live_version'),
      integer('draft_version'),
      json('state'),
    ],
  },
  {
    name: 'cfg_releases',
    title: 'Configurator · Releases',
    description: 'Append-only publish ledger.',
    titleField: 'workspace_slug',
    fields: [string('workspace_slug'), integer('version'), text('reason'), json('manifest'), string('published_by')],
  },
  {
    name: 'cfg_modules',
    title: 'Configurator · Modules',
    description: 'Projection of workspace state (rebuilt on save).',
    titleField: 'name',
    fields: [
      string('workspace_slug'),
      string('module_key'),
      string('name'),
      string('glyph'),
      string('kind'),
      string('status'),
      string('route'),
      json('data'),
    ],
  },
  {
    name: 'cfg_gates',
    title: 'Configurator · Gates',
    description: 'Projection of workspace state (rebuilt on save).',
    titleField: 'from_key',
    fields: [string('workspace_slug'), string('from_key'), string('to_key'), json('condition')],
  },
  {
    name: 'cfg_stages',
    title: 'Configurator · Stages',
    description: 'Projection of workspace state (rebuilt on save).',
    titleField: 'name',
    fields: [
      string('workspace_slug'),
      string('module_key'),
      integer('position'),
      string('name'),
      string('outcome'),
      boolean('terminal'),
      json('data'),
    ],
  },
];

/** Names of all configurator collections. */
export const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name);

// ---------------------------------------------------------------------------------------------
// NocoBase-owned collections (not part of the configurator contract, not in COLLECTIONS, so
// provision.mjs / reset.mjs / the client never touch them). Written only by NocoBase itself.

/** 64-bit integer (Postgres `bigint`), e.g. for snowflake ids of other rows. */
export const bigInt = (name) => ({
  name,
  interface: 'integer',
  type: 'bigInt',
  uiSchema: { type: 'number', title: title(name), 'x-component': 'InputNumber', 'x-component-props': { stringMode: true, step: '1' }, 'x-validator': 'integer' },
});

/** Date-time with time zone. */
export const datetime = (name, label = title(name)) => ({
  name,
  interface: 'datetime',
  type: 'date',
  uiSchema: { type: 'string', title: label, 'x-component': 'DatePicker', 'x-component-props': { showTime: true, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm:ss' } },
});

/**
 * Activity log written by the NocoBase workflow "Matrix Configurator · Release published → activity log"
 * (nocobase/scripts/provision-workflow.mjs) whenever a row is added to `cfg_releases`.
 * @type {CollectionDef}
 */
export const ACTIVITY_COLLECTION = {
  name: 'cfg_activity',
  title: 'Configurator · Activity',
  description: 'Publish activity log. Written by the NocoBase workflow on cfg_releases (after create); not by the configurator.',
  titleField: 'summary',
  fields: [
    string('event'),
    string('summary'),
    string('workspace_slug'),
    string('workspace_name'),
    integer('version'),
    text('reason'),
    string('published_by'),
    bigInt('release_id'),
    datetime('published_at', 'Published at'),
  ],
};
