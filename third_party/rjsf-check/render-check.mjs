#!/usr/bin/env node
// Proof that @rjsf/core 6.11.0 (Apache-2.0) renders and validates the schemas compiled by
// third_party/matrix-adapters/forms.py from REAL stage definitions.
//   stdin : [{ id, schema, uiSchema, samples: [values, ...] }, ...]
//   stdout: [{ id, rendered: [fieldKeys found in the markup], missing: [...], verdicts: [bool, ...], errors: [[msg...]] }]
// Server-side render (react-dom/server) — the same component tree the browser would mount.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { getDefaultRegistry } from '@rjsf/core';

const { widgets } = getDefaultRegistry();
// F4 supplies real widgets (file upload to the app's store, tier-filtered user picker); text stand-ins here.
const customWidgets = { MatrixFileWidget: widgets.TextWidget, MatrixPersonWidget: widgets.TextWidget };

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const forms = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const out = forms.map(({ id, schema, uiSchema, samples = [] }) => {
  const html = renderToStaticMarkup(React.createElement(Form, {
    schema, uiSchema, validator, widgets: customWidgets, liveValidate: false, formData: {},
  }));
  const keys = Object.keys(schema.properties || {});
  const rendered = keys.filter(k => html.includes(`id="root_${k}"`) || html.includes(`id="root_${k}-`) || html.includes(`root_${k}`));
  const results = samples.map(v => validator.validateFormData(v, schema));
  return {
    id,
    htmlBytes: html.length,
    rendered,
    missing: keys.filter(k => !rendered.includes(k)),
    verdicts: results.map(r => r.errors.length === 0),
    errors: results.map(r => r.errors.map(e => `${e.property || '(form)'}: ${e.message}`)),
  };
});
process.stdout.write(JSON.stringify(out));
