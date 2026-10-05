// Shared primitives for workspace kit (dark-default).

const Icon = ({ name, size = 16, stroke = 1.5, style }) => {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    box: <><path d="M2 9l10-6 10 6-10 6z"/><path d="M2 9v6l10 6 10-6V9"/></>,
    list: <><path d="M3 6h18M3 12h18M3 18h12"/></>,
    pin: <><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
    file: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><path d="M20 6L9 17l-5-5"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
    arrow: <><path d="M3 12h18M13 5l7 7-7 7"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></>,
    message: <><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></>,
    sparkle: <><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/></>,
    trend: <><path d="M3 3v18h18"/><path d="M7 14l3-3 4 4 5-7"/></>,
    shield: <><path d="M12 2l9 4v6c0 5-3.5 9.7-9 10-5.5-.3-9-5-9-10V6z"/></>,
    chat: <><path d="M21 11.5a8.5 8.5 0 01-15.4 5.1L3 21l4.4-2.6A8.5 8.5 0 1121 11.5z"/></>,
    user: <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
    chevron: <><path d="M9 6l6 6-6 6"/></>,
    chevronDown: <><path d="M6 9l6 6 6-6"/></>,
    chevronUp: <><path d="M6 15l6-6 6 6"/></>,
    x: <><path d="M18 6L6 18M6 6l12 12"/></>,
    activity: <><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>,
    folder: <><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></>,
    home: <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2h-4v-7H9v7H5a2 2 0 01-2-2z"/></>,
    terminal: <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>,
    wand: <><path d="M15 4l5 5"/><path d="M3 21l13-13"/><path d="M14 5l5 5"/><path d="M9 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></>,
    book: <><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></>,
    refresh: <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0114.85-3.36L23 10M1 14l4.65 4.36A9 9 0 0020.5 15"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {paths[name] || null}
    </svg>
  );
};

const Avatar = ({ name, size = 28 }) => {
  const initials = (name || '').split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <span style={{
      width: size, height: size, borderRadius: 999,
      background: 'rgba(0,180,216,0.16)', color: '#00B4D8',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: size * 0.4,
      letterSpacing: 0.5, flex: '0 0 auto',
    }}>{initials || '–'}</span>
  );
};

const Spark = ({ data, color = '#00B4D8', height = 36 }) => {
  const w = 140, h = height;
  const max = Math.max(...data), min = Math.min(...data);
  const norm = (v) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const points = data.map((v, i) => [i / (data.length - 1) * w, norm(v)]);
  const path = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`spark-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32"/>
          <stop offset="1" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${color.replace('#','')})`}/>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {points.slice(-1).map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill={color}/>
      ))}
    </svg>
  );
};

Object.assign(window, { Icon, Avatar, Spark });
