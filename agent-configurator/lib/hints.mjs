// App-parity: which free-text field validation hints the Matrix app can turn into real form rules.
// Port of the parse rules in app/backend/app/services/module_runtime/forms.py (field_schema), so an
// agent learns at add_field time — without signing in — that e.g. "min 0 · max 120" becomes
// minimum/maximum while "range" stays help text (the app reports those as `unparsed_hint` warnings
// at publish). The authoritative check remains the app's own dry run (validate op).

const NUM = '-?\\d+(?:\\.\\d+)?';
const RANGE = new RegExp(`^\\s*(${NUM})\\s*[–-]\\s*(${NUM})\\s*$`);
const MIN = new RegExp(`\\bmin\\s+(${NUM})`, 'i');
const MAX = new RegExp(`\\bmax\\s+(${NUM})(?![\\d.]|\\s*[kmg]?b\\b)`, 'i');
const FILE_MAX = /(?:max|≤)\s*(\d+(?:\.\d+)?)\s*([kmg]b)/i;
const FILE_TYPES = /\b(pdf|png|jpe?g|docx?|xlsx?|csv)\b/i;

export const HINT_FORMATS = Object.freeze({
  choice: 'options separated by " · " or "," — at least 2 (e.g. "yes · no · n/a"); becomes a radio/select',
  yesno: 'leave empty (a yes/no is always a boolean)',
  number: '"min 0 · max 120", "min 1", "max 50" or a range "0–100"; "₹" adds a rupee prefix',
  text: 'a regular expression starting with "^" (e.g. "^[0-9]{6}$"); anything else is help text only',
  date: 'leave empty (a date is always a date picker; other text is help text only)',
  file: 'allowed types and/or size, e.g. "pdf · max 10MB" or "png, jpg"',
  person: 'the tier to pick from, e.g. "supervisor" or "executive"',
});

/** → { parsed: boolean, note?: string } for a field kind + hint, mirroring forms.field_schema. */
export function parseHint(kind, hint) {
  const h = String(hint || '').trim();
  if (!h || h === '—') return { parsed: true };
  switch (kind) {
    case 'choice': {
      const sep = h.includes('·') ? '·' : (h.includes(',') ? ',' : null);
      const opts = sep ? h.split(sep).map(o => o.trim()).filter(Boolean) : [];
      return opts.length >= 2 ? { parsed: true, note: 'options: ' + opts.join(' | ') } : { parsed: false };
    }
    case 'number': {
      const r = RANGE.exec(h);
      if (r) return { parsed: true, note: `minimum ${r[1]}, maximum ${r[2]}` };
      const lo = MIN.exec(h), hi = MAX.exec(h);
      if (lo || hi) return { parsed: true, note: [lo && 'minimum ' + lo[1], hi && 'maximum ' + hi[1]].filter(Boolean).join(', ') };
      if (h === '₹' || h === '₹ per month') return { parsed: true, note: 'rupee prefix' };
      return { parsed: false };
    }
    case 'file': {
      const types = FILE_TYPES.test(h), size = FILE_MAX.test(h);
      return types || size ? { parsed: true } : { parsed: false };
    }
    case 'person': return { parsed: true, note: 'tier filter: ' + h };
    case 'yesno':
    case 'date': return { parsed: false };
    default: { // text
      if (h.startsWith('^')) { try { new RegExp(h, 'u'); return { parsed: true, note: 'pattern' }; } catch { return { parsed: false }; } }
      return { parsed: false };
    }
  }
}
