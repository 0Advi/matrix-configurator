import React from 'react';

// Clickable KPI tile card — same look as the staging KpiTile strip (small
// uppercase label, mono value, sub line, colored top rule) but acts as a
// toggleable filter. Used on the Shortlist and Sites in process TABS; the
// Overview drill-down uses the compact SubFilterPill chips instead.
export default function StateKpiTile({ label, value, sub, color = 'var(--zm-fg-3)', active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, minWidth: 150, padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 4,
        background: active ? 'var(--zm-accent-soft)' : 'var(--zm-surface)',
        border: active ? '1px solid var(--zm-accent)' : '1px solid var(--zm-line)',
        borderTop: '2px solid ' + (active ? 'var(--zm-accent)' : color),
        borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        transition: 'background 120ms var(--zm-ease), border 120ms var(--zm-ease)',
      }}
    >
      <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: active ? 'var(--zm-accent)' : 'var(--zm-fg-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", fontSize: 22, fontWeight: 600, color: active ? 'var(--zm-accent)' : color, lineHeight: 1.1 }}>{String(value).padStart(2, '0')}</span>
      {sub && (<span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 11, color: 'var(--zm-fg-3)' }}>{sub}</span>)}
    </button>
  );
}
