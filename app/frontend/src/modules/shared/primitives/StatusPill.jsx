import React from 'react';
import { STAGES, TONES } from './constants.js';

// Render body preserved exactly from Primitives.jsx.
export function StageDot({ stage, size = 8 }) {
  return (
    <span style={{ display: 'inline-block', width: size, height: size, borderRadius: 999, background: STAGES[stage]?.color || '#888', flex: '0 0 auto' }} />
  );
}

export default function StatusPill({ stage }) {
  const s = STAGES[stage] || STAGES.draft;
  const t = TONES[s.tone] || TONES.neutral;
  return (
    <span className="zm-status-pill" style={{
      '--pill-fg': t.fg, '--pill-bg': t.bg, '--pill-edge': t.edge, '--pill-mark': t.mark,
      display: 'inline-flex', alignItems: 'center', gap: 0,
      height: 22, padding: 0, borderRadius: 5,
      background: t.bg, color: t.fg,
      border: '1px solid ' + t.edge,
      fontFamily: 'var(--zm-font-body)', fontWeight: 700,
      fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', lineHeight: 1, position: 'relative',
      overflow: 'hidden',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)',
    }}>
      <span style={{ width: 3, alignSelf: 'stretch', background: t.mark, flex: '0 0 3px' }}/>
      <span style={{ padding: '0 10px 0 9px', fontFeatureSettings: "'ss01' 1" }}>{s.name}</span>
    </span>
  );
}
