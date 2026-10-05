// rjsf widgets named by the backend's form compiler (module_runtime/forms.py):
//   MatrixPersonWidget  — kind "person": pick a member of this module; value = user id.
//                         `ui:options.tier` (the field's validation hint) filters by role.
//   MatrixFileWidget    — kind "file": the app has NO upload endpoint for custom-module
//                         files yet (docs/F4-API.md §5). Rather than a dead control, the widget
//                         says so plainly and accepts a reference (document name / link) so a
//                         required field does not block the stage. Recorded as a gap.
import React from 'react';

export const MembersContext = React.createContext({ members: [], status: 'idle' });

const inputStyle = {
  height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--zm-line-strong)',
  background: 'var(--zm-surface)', color: 'var(--zm-fg)', fontFamily: 'var(--zm-font-body)', fontSize: 13, width: '100%', boxSizing: 'border-box',
};

export function tierFilter(members, tierHint) {
  const hint = String(tierHint || '').toLowerCase();
  const tier = ['executive', 'supervisor'].find((t) => hint.includes(t));
  return tier ? members.filter((m) => m.role_in_module === tier) : members;
}

export function MatrixPersonWidget({ id, value, onChange, options, required, disabled, readonly, onBlur, onFocus }) {
  const { members, status } = React.useContext(MembersContext);
  const list = tierFilter(members || [], options?.tier);
  return (
    <select id={id} value={value || ''} required={required} disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value || undefined)}
      onBlur={() => onBlur?.(id, value)} onFocus={() => onFocus?.(id, value)} style={inputStyle}>
      <option value="">{status === 'loading' ? 'Loading people…' : list.length ? 'Choose a person…' : 'No one in this module yet'}</option>
      {list.map((m) => <option key={m.id} value={m.id}>{m.name || m.email} · {m.role_in_module}</option>)}
    </select>
  );
}

export function MatrixFileWidget({ id, value, onChange, options, required, disabled, readonly }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div role="note" data-testid="file-unsupported" style={{ padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.45,
        background: 'var(--zm-warning-soft)', border: '1px solid color-mix(in srgb, var(--zm-warning) 40%, transparent)', color: 'var(--zm-fg)' }}>
        File upload isn’t available for configurator-built modules yet{options?.accept ? ` (expected: ${options.accept}${options.maxSize ? `, max ${options.maxSize}` : ''})` : ''}.
        Share the document the usual way and enter its name or link below.
      </div>
      <input id={id} type="text" value={value || ''} required={required} disabled={disabled || readonly}
        placeholder="Document reference (name or link)" onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle}/>
    </div>
  );
}

export const WIDGETS = { MatrixPersonWidget, MatrixFileWidget };
