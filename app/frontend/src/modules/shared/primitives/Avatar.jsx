import React from 'react';

// Render body preserved exactly from Primitives.jsx.
export default function Avatar({ name, size = 28 }) {
  const initials = (name || '').split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <span style={{
      width: size, height: size, borderRadius: 999,
      background: 'var(--zm-accent-soft)', color: 'var(--zm-accent)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: size * 0.4,
      letterSpacing: 0.5, flex: '0 0 auto',
    }}>{initials || '–'}</span>
  );
}
