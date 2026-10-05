import React from 'react';

// Sub-state filter pill — small chip with a colored dot and count that
// toggles a sub-filter (e.g. Awaiting details / Pending approval under
// Shortlist, Awaiting LOI / Awaiting approval under Sites in process).
// Matches the Overview stage-chip styling: active = inverted fill.
export default function SubFilterPill({ label, count, color, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="zm-pill"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, padding: '0 12px',
        borderRadius: 999,
        border: '1px solid ' + (active ? 'var(--zm-fg)' : 'var(--zm-line)'),
        background: active ? 'var(--zm-fg)' : 'var(--zm-surface)',
        color: active ? 'var(--zm-fg-inv)' : 'var(--zm-fg-2)',
        fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', transition: 'all 120ms var(--zm-ease)',
      }}
    >
      {color && <span style={{ width: 6, height: 6, borderRadius: 999, background: color }}/>}
      {label}
      {count != null && (
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontWeight: 500, fontSize: 11, color: active ? 'var(--zm-fg-inv)' : 'var(--zm-fg-3)', opacity: active ? 0.7 : 1 }}>{count}</span>
      )}
    </button>
  );
}
