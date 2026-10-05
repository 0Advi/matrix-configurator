import React from 'react';
import Icon from './Icon.jsx';

// SearchBox — rounded search input used by overview drill-down views.
// Extracted from the BD OverviewPage so module overviews share one copy.
export default function SearchBox({ value, onChange, placeholder = 'Search code, site, city…' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px', flex: '1 1 240px', maxWidth: 360, border: '1px solid var(--zm-line)', borderRadius: 999, background: 'var(--zm-surface)' }}>
      <Icon name="search" size={14} style={{ color: 'var(--zm-fg-3)' }}/>
      <input
        value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}
      />
      {value && (
        <button onClick={() => onChange('')} style={{ background: 'transparent', border: 'none', color: 'var(--zm-fg-3)', padding: 0, cursor: 'pointer', display: 'inline-flex' }}><Icon name="x" size={12}/></button>
      )}
    </div>
  );
}
