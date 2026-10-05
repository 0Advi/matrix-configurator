// A tiny, dependency-free JSON Schema validator covering the subset used by the
// building-block schemas: type (incl. arrays of types), properties, required,
// additionalProperties (boolean | schema), items (schema | tuple via prefixItems),
// enum, const, pattern, minLength, minimum, minItems, maxItems, uniqueItems,
// anyOf, oneOf, $ref to "#/$defs/<name>" (or "#/definitions/<name>").
// Returns an array of error strings ("" path = root). Empty array → valid.

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (want, v) => {
  const t = typeOf(v);
  return want === t || (want === 'number' && (t === 'integer' || t === 'number'));
};

export function validate(schema, value, root = schema, path = '') {
  const errs = [];
  const err = m => errs.push((path || '/') + ': ' + m);
  if (schema === true || schema === undefined) return errs;
  if (schema === false) { err('not allowed'); return errs; }
  if (schema.$ref === '#') return validate(root, value, root, path);
  if (schema.$ref) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(schema.$ref);
    if (!m || !root[m[1]] || !root[m[1]][m[2]]) { err('unresolvable $ref ' + schema.$ref); return errs; }
    return validate(root[m[1]][m[2]], value, root, path);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeMatches(t, value))) { err('expected ' + types.join('|') + ', got ' + typeOf(value)); return errs; }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) err('expected const ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) err('not in enum: ' + JSON.stringify(value));
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err('does not match ' + schema.pattern + ': ' + JSON.stringify(value));
    if (schema.minLength !== undefined && [...value].length < schema.minLength) err('shorter than ' + schema.minLength);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) err('below minimum ' + schema.minimum);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err('fewer than ' + schema.minItems + ' items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err('more than ' + schema.maxItems + ' items');
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) err('items not unique');
    if (schema.prefixItems) schema.prefixItems.forEach((s, i) => { if (i < value.length) errs.push(...validate(s, value[i], root, path + '/' + i)); });
    if (schema.items !== undefined) value.forEach((v, i) => { if (!schema.prefixItems || i >= schema.prefixItems.length) errs.push(...validate(schema.items, v, root, path + '/' + i)); });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) err('missing required property ' + r);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(props[k], v, root, path + '/' + k));
      else if (schema.additionalProperties === false) err('unexpected property ' + k);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, root, path + '/' + k));
    }
  }
  if (schema.anyOf && !schema.anyOf.some(s => validate(s, value, root, path).length === 0)) err('matches none of anyOf');
  if (schema.oneOf) {
    const n = schema.oneOf.filter(s => validate(s, value, root, path).length === 0).length;
    if (n !== 1) err('matches ' + n + ' of oneOf (expected exactly 1)');
  }
  return errs;
}
