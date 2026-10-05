// The "locked" screen for a configurator-defined module whose entry gate is closed for a site
// (409 gate_closed, or the ?site_id gate preview). Built only from the backend's explanation:
// gate = {open, refusal, match: all|any, conditions: [{source, outcome, met, reached[]}]}.
import React from 'react';
import Icon from '../shared/primitives/Icon.jsx';
import { Card, Button } from './kit.jsx';

export default function GateLocked({ moduleLabel, site, gate, onRetry, onClose, busy }) {
  const conditions = Array.isArray(gate?.conditions) ? gate.conditions : [];
  const metCount = conditions.filter((c) => c.met).length;
  const labelOf = (src) => gate?.sourceLabels?.[src] || src;
  return (
    <Card role="region" aria-label={`${moduleLabel} is locked`} style={{ borderColor: 'color-mix(in srgb, var(--zm-warning) 45%, var(--zm-line))' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--zm-warning-soft)', color: 'var(--zm-warning)', flexShrink: 0 }}><Icon name="lock" size={18}/></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>
            Locked{site ? ` · ${site.name || site.code || ''}` : ''}
          </div>
          <h3 style={{ margin: '4px 0 6px', fontSize: 18, fontWeight: 750, color: 'var(--zm-fg)' }}>
            {gate?.refusal || `${moduleLabel} can’t start for this site yet.`}
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--zm-fg-2)' }}>
            {conditions.length === 0
              ? 'The module’s entry gate is closed.'
              : <>It opens when <b>{gate?.match === 'any' ? 'any one' : 'all'}</b> of these {gate?.match === 'any' ? 'is' : 'are'} true — {metCount} of {conditions.length} met so far.</>}
          </p>
          <ul aria-label="Gate conditions" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {conditions.map((c, i) => (
              <li key={`${c.source}-${c.outcome}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderRadius: 9,
                border: '1px solid var(--zm-line)', background: c.met ? 'var(--zm-success-soft)' : 'var(--zm-surface-2)' }}>
                <span aria-label={c.met ? 'met' : 'not met'} style={{ color: c.met ? 'var(--zm-success)' : 'var(--zm-fg-4)', marginTop: 1 }}>
                  <Icon name={c.met ? 'check' : 'clock'} size={14}/>
                </span>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--zm-fg)' }}>
                  <b>{labelOf(c.source)}</b> has reached “{c.outcome}”
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--zm-fg-3)', marginTop: 2 }}>
                    {Array.isArray(c.reached) && c.reached.length ? `Reached so far: ${c.reached.join(', ')}` : 'Nothing reached yet for this site'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {(onRetry || onClose) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              {onRetry && <Button variant="primary" icon="refresh" busy={busy} onClick={onRetry}>Check again</Button>}
              {onClose && <Button onClick={onClose}>Close</Button>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
