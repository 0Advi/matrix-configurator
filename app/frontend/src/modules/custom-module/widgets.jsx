// rjsf widgets named by the backend's form compiler (module_runtime/forms.py):
//   MatrixPersonWidget  — kind "person": pick a member of this module; value = user id.
//                         `ui:options.tier` (the field's validation hint) filters by role.
//   MatrixFileWidget    — kind "file": F5a — uploads to POST /m/{key}/records/{id}/files (the
//                         app's storage bucket; type/size from `ui:options.accept/maxSize`, checked
//                         here AND by the backend); the value is the returned file id, which the
//                         backend verifies belongs to this case, stage and field on submit.
import React from 'react';

export const MembersContext = React.createContext({ members: [], status: 'idle' });
// F5a: the case the form belongs to (module key, record id) and the files already uploaded for it
// (GET …/records/{id} → `files`: {file_id: {file_name, content_type, size, stage, field}}).
export const RecordContext = React.createContext({ moduleKey: null, recordId: null, files: {} });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** "2MB" → bytes (null when absent/unreadable). */
export function parseMaxSize(text) {
  const m = String(text || '').trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i);
  return m ? Math.floor(Number(m[1]) * UNITS[m[2].toUpperCase()]) : null;
}

/** Client-side mirror of the backend's checks (the backend still decides). → error text | null */
export function checkFile(file, options) {
  const max = parseMaxSize(options?.maxSize);
  if (max && file.size > max) return `This file is larger than ${options.maxSize}.`;
  const accept = String(options?.accept || '').split(',').map((a) => a.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (accept.length) {
    let ext = (String(file.name || '').split('.').pop() || '').toLowerCase();
    if (ext === 'jpg') ext = 'jpeg';
    if (!String(file.name || '').includes('.') || !accept.includes(ext)) return `This field accepts ${accept.map((a) => `.${a}`).join(', ')} files only.`;
  }
  return null;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 ** 2) * 10) / 10} MB`;
}

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

export function MatrixFileWidget({ id, name, value, onChange, options, required, disabled, readonly }) {
  const { moduleKey, recordId, files, upload, open } = React.useContext(RecordContext);
  const field = name || String(id || '').replace(/^root_/, '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [mine, setMine] = React.useState(null); // the file uploaded in this session (before a refetch)
  const inputRef = React.useRef(null);
  const meta = value ? ((mine && mine.id === value) ? mine : files?.[value] || null) : null;
  const legacy = value && !UUID_RE.test(String(value));
  const off = disabled || readonly || busy || !moduleKey || !recordId;

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = checkFile(file, options);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const res = await upload(moduleKey, recordId, field, file);
      setMine(res);
      onChange(res.id);
    } catch (err) {
      setError(err?.detail || err?.message || 'Upload failed.');
    } finally { setBusy(false); }
  };

  const hint = [options?.accept, options?.maxSize && `max ${options.maxSize}`].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="file-widget">
      {meta && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
          <span aria-hidden>📎</span>
          <button type="button" onClick={() => open(moduleKey, value)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--zm-accent)', cursor: 'pointer', fontSize: 13, textDecoration: 'underline' }}>
            {meta.file_name}
          </button>
          <span style={{ color: 'var(--zm-fg-3)', fontSize: 12 }}>{formatBytes(meta.size)}</span>
          {!off && <button type="button" onClick={() => onChange(undefined)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--zm-fg-3)', cursor: 'pointer', fontSize: 12 }}>Remove</button>}
        </div>
      )}
      {legacy && (
        <div role="note" style={{ fontSize: 12, color: 'var(--zm-fg-3)' }}>
          Earlier reference “{String(value)}” — upload the document to replace it.
        </div>
      )}
      <input ref={inputRef} id={id} type="file" aria-label={meta ? 'Replace file' : 'Upload file'} accept={options?.accept || undefined}
        required={required && !value} disabled={off} onChange={pick} style={{ fontSize: 12.5 }}/>
      <span style={{ fontSize: 11.5, color: 'var(--zm-fg-3)' }}>
        {busy ? 'Uploading…' : meta ? 'Choose another file to replace it.' : `Upload a file${hint ? ` (${hint})` : ''}.`}
      </span>
      {error && <span role="alert" style={{ fontSize: 12, color: 'var(--zm-danger)' }}>{error}</span>}
    </div>
  );
}

export const WIDGETS = { MatrixPersonWidget, MatrixFileWidget };
