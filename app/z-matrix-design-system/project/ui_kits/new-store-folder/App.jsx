// Z-Matrix · new-store-folder app
//
// Workflow (per-role views):
//   Pipeline (drafts) → Shortlist queue → Staging (LOI) → exit to Payments module
//
// RBAC: BD exec sees ONLY sites they originated. Supervisor sees all.
// Pipeline SLA: supervisor should action a draft within 7 days; overdue rows are red.
// Staging is two-step: exec uploads LOI; once uploaded the site enters the
// supervisor's staging view where they View LOI + Push site (and see a timer
// of draft date → LOI upload date against the expected timeline).

const ME = 'Riya Sharma';

const DRAFTS = [
  { id: 'site_h9d31a40', code: 'BT-MUM-0144', name: 'BKC One · East Wing',     city: 'Mumbai',    visitDate: '2026-05-18', days: 1,  createdBy: 'Riya Sharma',   stage: 'draft' },
  { id: 'site_i1e42a51', code: 'BT-CHE-0011', name: 'Anna Nagar 2nd Ave',       city: 'Chennai',   visitDate: '2026-05-16', days: 3,  createdBy: 'Aman Verma',    stage: 'draft' },
  { id: 'site_j2f53b62', code: 'BT-AHM-0008', name: 'CG Road · Navrangpura',    city: 'Ahmedabad', visitDate: '2026-05-14', days: 5,  createdBy: 'Nikhil Iyer',   stage: 'draft' },
  { id: 'site_k3g64c73', code: 'BT-BLR-0210', name: 'HSR Layout 27th Main',     city: 'Bengaluru', visitDate: '2026-05-13', days: 7,  createdBy: 'Aisha Sengupta',stage: 'draft' },
  { id: 'site_l4h75d84', code: 'BT-PUN-0024', name: 'Baner High Street',       city: 'Pune',      visitDate: '2026-05-11', days: 9,  createdBy: 'Riya Sharma',   stage: 'draft' },
  { id: 'site_m5i86e95', code: 'BT-MUM-0145', name: 'Lokhandwala Back Rd',     city: 'Mumbai',    visitDate: '2026-05-08', days: 12, createdBy: 'Aman Verma',    stage: 'draft' },
  { id: 'site_n6j97f06', code: 'BT-HYD-0036', name: 'Jubilee Hills Rd 36',     city: 'Hyderabad', visitDate: '2026-04-29', days: 21, createdBy: 'Nikhil Iyer',   stage: 'draft' },
  { id: 'site_o7k08g17', code: 'BT-DEL-0091', name: 'Saket M-Block · L13',     city: 'New Delhi', visitDate: '2026-04-26', days: 24, createdBy: 'Aisha Sengupta',stage: 'draft' },
  { id: 'site_p8l19h28', code: 'BT-BLR-0211', name: 'Whitefield · Hope Farm',   city: 'Bengaluru', visitDate: '2026-04-22', days: 28, createdBy: 'Aman Verma',    stage: 'draft' },
];

const SHORTLIST = [
  // Riya's: one in review (essentials done), one still needing details
  { code: 'BT-MUM-0143', name: 'Bandra Linking Rd',      city: 'Mumbai',    visitDate: '2026-05-17', createdBy: 'Riya Sharma',   score: 78, estSales: 19.8, carpet: 1120, rent: 112, rentType: 'fixed', totalOpCost: 165000, hue: 140, inReview: true,  stage: 'shortlist' },
  { code: 'BT-MUM-0146', name: 'Borivali West · Carter', city: 'Mumbai',    visitDate: '2026-05-15', createdBy: 'Riya Sharma',   score: '',  estSales: '',   carpet: '',   rent: '',  rentType: '',      totalOpCost: 0,      hue: 220, inReview: false, stage: 'shortlist' },
  // Others' shortlists (supervisor will see these too)
  { code: 'BT-BLR-0209', name: 'Koramangala 6th Block',  city: 'Bengaluru', visitDate: '2026-05-15', createdBy: 'Aman Verma',    score: '',  estSales: '',   carpet: '',   rent: '',  rentType: '',      totalOpCost: 0,      hue: 30,  inReview: false, stage: 'shortlist' },
  { code: 'BT-DEL-0090', name: 'Connaught Place · F-21', city: 'New Delhi', visitDate: '2026-05-12', createdBy: 'Nikhil Iyer',   score: 82, estSales: 22.0, carpet: 1320, rent: 142, rentType: 'fixed', totalOpCost: 198000, hue: 200, inReview: true,  stage: 'shortlist' },
];

const STAGING = [
  // Riya's approved sites: one overdue + needs LOI, one uploaded recently (supervisor view), one early upload
  { id: 'site_a8f3c129', code: 'BT-MUM-0142', name: 'Powai · Lake Homes',      city: 'Mumbai',    createdBy: 'Riya Sharma',   spocName: 'Rohan Khanna',  draftDate: '2026-05-01', approvedDate: '2026-05-03', approvedBy: 'N. Iyer',   expectedLoiDays: 14, daysSinceApproval: 16, loiUploaded: false, loiUploadedAt: null,        daysToLOI: null, pushed: false, stage: 'staging' },
  { id: 'site_e2c1f8a3', code: 'BT-HYD-0034', name: 'Banjara Hills Rd 12',     city: 'Hyderabad', createdBy: 'Riya Sharma',   spocName: 'Pranav Reddy',  draftDate: '2026-05-08', approvedDate: '2026-05-10', approvedBy: 'R. Sharma', expectedLoiDays: 14, daysSinceApproval: 9,  loiUploaded: false, loiUploadedAt: null,        daysToLOI: null, pushed: false, stage: 'staging' },
  // Already uploaded by Riya — appears in supervisor's staging
  { id: 'site_q9m20i39', code: 'BT-MUM-0140', name: 'Andheri · Lokhandwala',   city: 'Mumbai',    createdBy: 'Riya Sharma',   spocName: 'Tanvi Joshi',   draftDate: '2026-04-06', approvedDate: '2026-04-08', approvedBy: 'N. Iyer',   expectedLoiDays: 14, daysSinceApproval: 14, loiUploaded: true,  loiUploadedAt: '2026-04-21', daysToLOI: 13, pushed: false, stage: 'staging' },
  // Others' sites
  { id: 'site_c4d09f02', code: 'BT-DEL-0089', name: 'Khan Market · Shop 27',   city: 'New Delhi', createdBy: 'Nikhil Iyer',   spocName: 'Devansh Roy',   draftDate: '2026-04-20', approvedDate: '2026-04-22', approvedBy: 'N. Iyer',   expectedLoiDays: 21, daysSinceApproval: 27, loiUploaded: false, loiUploadedAt: null,        daysToLOI: null, pushed: false, stage: 'staging' },
  { id: 'site_g8c20d12', code: 'BT-PUN-0021', name: 'Koregaon Park Lane 5',    city: 'Pune',      createdBy: 'Nikhil Iyer',   spocName: 'Yash Bhide',    draftDate: '2026-04-13', approvedDate: '2026-04-15', approvedBy: 'N. Iyer',   expectedLoiDays: 21, daysSinceApproval: 34, loiUploaded: false, loiUploadedAt: null,        daysToLOI: null, pushed: false, stage: 'staging' },
  { id: 'site_r0n31j40', code: 'BT-DEL-0086', name: 'GK-1 N-Block · 142',      city: 'New Delhi', createdBy: 'Aman Verma',    spocName: 'Vikram Anand',  draftDate: '2026-03-30', approvedDate: '2026-04-02', approvedBy: 'R. Sharma', expectedLoiDays: 21, daysSinceApproval: 20, loiUploaded: true,  loiUploadedAt: '2026-04-22', daysToLOI: 20, pushed: false, stage: 'staging' },
  { id: 'site_b7e2118a', code: 'BT-BLR-0207', name: 'Indiranagar 12th Main',   city: 'Bengaluru', createdBy: 'Aman Verma',    spocName: 'Aisha Mehta',   draftDate: '2026-05-10', approvedDate: '2026-05-12', approvedBy: 'R. Sharma', expectedLoiDays: 14, daysSinceApproval: 6,  loiUploaded: false, loiUploadedAt: null,        daysToLOI: null, pushed: false, stage: 'staging' },
];

const ARCHIVE_SEED = [
  { id: 'site_arch_001', code: 'BT-MUM-0091', name: 'Khar · Linking Rd 33',  city: 'Mumbai',    createdBy: 'Aman Verma', archivedAt: '2026-04-12', reasons: ['High rent', 'High cannibalisation'], note: '' },
  { id: 'site_arch_002', code: 'BT-DEL-0072', name: 'Defence Colony · 12B',  city: 'New Delhi', createdBy: 'Nikhil Iyer', archivedAt: '2026-03-30', reasons: ['Affluence problem'], note: '' },
];

const buildDrawerSite = (row) => ({
  ...row,
  id: row.id || row.code, code: row.code, name: row.name, city: row.city,
  stage: row.stage || 'shortlist',
  carpet: row.carpet || 1000,
  opCost: row.totalOpCost || 100000,
  rent: row.rent || 80000, cam: row.cam || 18000,
  deposit: row.deposit || 400000, lockin: row.lockin || 36, escalation: row.escalation || 5,
  rentFree: row.rentFreeDays || 30, estSales: (row.estSales || 12) * 100000, model: row.model || 'Café · 900–1200 sqft',
  spocName: row.spocName || row.createdBy || row.by || 'TBD',
  spocPhone: '+91 ••••• •••••',
  pin: row.googlePin || row.pin || '—',
  loiSignedAt: row.loiUploadedAt || '—',
  loiSubmittedAt: row.loiUploadedAt || '—',
  days: row.days ?? row.daysSinceApproval ?? 0,
  createdAt: row.createdAt || row.visitDate || '—',
});

const App = () => {
  const [role, setRole] = React.useState('supervisor');
  const [dark, setDark] = React.useState(false);
  const [view, setView] = React.useState('overview');
  const [stage, setStage] = React.useState('all');
  const [advanced, setAdvanced] = React.useState({ month: '', preset: '', from: '', to: '' });
  const [openSite, setOpenSite] = React.useState(null);
  const [showNew, setShowNew] = React.useState(false);
  const [approving, setApproving] = React.useState(null);   // shortlist item being approved
  const [rejecting, setRejecting] = React.useState(null);   // draft being rejected
  const [detailing, setDetailing] = React.useState(null);   // shortlist item being detailed
  const [toast, setToast] = React.useState(null);

  const [drafts, setDrafts]       = React.useState(DRAFTS);
  const [shortlist, setShortlist] = React.useState(SHORTLIST);
  const [staging, setStaging]     = React.useState(STAGING);
  const [archive, setArchive]     = React.useState(ARCHIVE_SEED);

  React.useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.body.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg, tone = 'success') => setToast({ msg, tone });

  // ============ RBAC ============
  // BD exec only sees sites they originated. Supervisor sees all.
  // Staging additionally splits by upload state:
  //   - supervisor staging view shows ONLY sites with loiUploaded === true
  //   - exec staging view shows their own approved sites regardless of upload state
  const isExec = role === 'exec';

  const visibleDrafts    = isExec ? drafts.filter(d => d.createdBy === ME)    : drafts;
  const visibleShortlist = isExec ? shortlist.filter(s => s.createdBy === ME) : shortlist;
  const visibleStaging   = isExec
    ? staging.filter(s => s.createdBy === ME)
    : staging.filter(s => s.loiUploaded === true);

  // ============ Pipeline → Shortlist ============
  const onDraftApprove = (d) => {
    setDrafts(prev => prev.filter(x => x.id !== d.id));
    setShortlist(prev => [{
      code: d.code, name: d.name, city: d.city, visitDate: d.visitDate,
      createdBy: d.createdBy,
      score: '', estSales: '', carpet: '', rent: '', rentType: '', totalOpCost: 0,
      hue: Math.round(Math.random() * 360),
      inReview: false, stage: 'shortlist',
    }, ...prev]);
    showToast(`Shortlisted · ${d.name} moved to shortlist queue`);
  };

  const onDraftReject = (d) => setRejecting(d);

  const onDraftRejectConfirm = (d, reasons, comment) => {
    setRejecting(null);
    setDrafts(prev => prev.filter(x => x.id !== d.id));
    setArchive(prev => [{
      id: d.id, code: d.code, name: d.name, city: d.city,
      createdBy: d.createdBy, archivedAt: new Date().toISOString().slice(0,10),
      reasons, note: comment, source: 'rejected',
    }, ...prev]);
    showToast(`Rejected · ${d.name} · archived with ${reasons.length} reason${reasons.length === 1 ? '' : 's'}`, 'danger');
  };

  const onDraftArchive = (d) => {
    setDrafts(prev => prev.filter(x => x.id !== d.id));
    setArchive(prev => [{
      id: d.id, code: d.code, name: d.name, city: d.city,
      createdBy: d.createdBy, archivedAt: new Date().toISOString().slice(0,10),
      reasons: [], note: 'Archived for future reference', source: 'archived',
    }, ...prev]);
    showToast(`Archived · ${d.name}. Available in Archive view.`);
  };

  // ============ Shortlist actions ============
  // BD exec opens the 17-field form. On submit, item is marked inReview.
  const onAddDetails = (item) => setDetailing(item);

  const onDetailsSubmit = (item, formData) => {
    setDetailing(null);
    setShortlist(prev => prev.map(x => x.code === item.code ? {
      ...x,
      details: formData,
      name: formData.name,
      city: formData.city,
      score: Number(formData.score) || x.score,
      estSales: Number(formData.estSales) / 100000 || x.estSales,   // store in lakhs
      carpet: Number(formData.carpet) || x.carpet,
      rent: Math.round(Number(formData.rent) / 1000) || x.rent,     // store in thousands
      rentType: formData.rentType,
      totalOpCost: formData.totalOpCost,
      inReview: true,
    } : x));
    showToast(`Sent for review · ${formData.name}. Supervisor notified.`);
  };

  // Persist partial form state so the exec can resume later. Crucially we
  // do NOT set `inReview: true` — supervisor must not see this as approvable.
  const onDetailsSaveDraft = (item, formData) => {
    setDetailing(null);
    setShortlist(prev => prev.map(x => x.code === item.code ? {
      ...x,
      details: formData,
      name: formData.name || x.name,
      city: formData.city || x.city,
    } : x));
    showToast(`Draft saved · ${item.name}. Continue anytime from the shortlist.`);
  };

  // Supervisor approve shortlist → LOI timeline modal
  const onApproveShortlist = (item) => setApproving(item);

  const onTimelineSubmit = (item, days) => {
    setApproving(null);
    setShortlist(prev => prev.filter(x => x.code !== item.code));
    setStaging(prev => [{
      id: 'site_' + Math.random().toString(36).slice(2, 10),
      code: item.code, name: item.name, city: item.city,
      createdBy: item.createdBy,
      spocName: item.details?.spocName || item.createdBy,
      draftDate: item.visitDate || new Date().toISOString().slice(0,10),
      approvedDate: new Date().toISOString().slice(0, 10),
      approvedBy: 'R. Sharma',
      expectedLoiDays: days, daysSinceApproval: 0,
      loiUploaded: false, loiUploadedAt: null, daysToLOI: null,
      pushed: false, stage: 'staging',
    }, ...prev]);
    showToast(`Approved · ${item.name}. LOI expected in ${days}d. Moved to staging.`);
  };

  // ============ Staging actions ============
  // Exec uploads LOI → site now visible in supervisor staging
  const onUploadLOI = (site) => {
    setStaging(prev => prev.map(x => x.id === site.id ? {
      ...x, loiUploaded: true,
      loiUploadedAt: new Date().toISOString().slice(0,10),
      daysToLOI: x.daysSinceApproval,
    } : x));
    showToast(`LOI uploaded · ${site.name}. Supervisor will review and push.`);
  };

  // Supervisor pushes the site → leaves staging (out to Payments module)
  const onPushSite = (site) => {
    setStaging(prev => prev.map(x => x.id === site.id ? { ...x, pushed: true } : x));
    showToast(`Pushed · ${site.name} sent to Payments module.`);
  };

  const onViewLOI = (site) => {
    showToast(`Opening LOI · ${site.name} (mock).`);
  };

  const counts = {
    pipeline: visibleDrafts.length,
    shortlist: visibleShortlist.length,
    staging: visibleStaging.length,
    archive: archive.length,
  };

  // ============ Live metrics for Sites-in-motion overview ============
  // Role-scoped: exec sees their own sites; supervisor sees everyone's.
  const loiDue      = visibleStaging.filter(s => !s.loiUploaded && s.daysSinceApproval <= s.expectedLoiDays).length;
  const loiOverdue  = visibleStaging.filter(s => !s.loiUploaded && s.daysSinceApproval > s.expectedLoiDays).length;
  const inReview    = visibleShortlist.filter(s => s.inReview).length;
  const oldestDraft = visibleDrafts.reduce((m, d) => Math.max(m, d.days || 0), 0);
  // Supervisor SLA: drafts > 7 days are stale.
  const staleDrafts = role === 'supervisor' ? visibleDrafts.filter(d => d.days > 7).length : 0;
  const totalMotion = visibleDrafts.length + visibleShortlist.length + visibleStaging.length;
  const cityCount   = new Set([
    ...visibleDrafts.map(d => d.city),
    ...visibleShortlist.map(s => s.city),
    ...visibleStaging.map(s => s.city),
  ]).size;

  const metrics = {
    inMotion: {
      value: String(totalMotion).padStart(2, '0'),
      delta: isExec ? `your sites · ${ME.split(' ')[0]}` : 'tenant-wide',
      sub: `across ${cityCount} cit${cityCount === 1 ? 'y' : 'ies'}`,
    },
    drafts: {
      value: String(visibleDrafts.length).padStart(2, '0'),
      delta: oldestDraft > 0 ? `oldest · ${oldestDraft}d` : 'none open',
      deltaTone: staleDrafts > 0 ? 'neg' : 'pos',
      sub: role === 'supervisor'
        ? (staleDrafts > 0 ? `${staleDrafts} past 7-day SLA` : 'awaiting your decision')
        : 'awaiting supervisor',
    },
    shortlist: {
      value: String(visibleShortlist.length).padStart(2, '0'),
      delta: inReview > 0 ? `${inReview} in review` : 'all need details',
      sub: role === 'supervisor' ? 'ready to approve' : 'fill 17 fields',
    },
    loi: {
      value: String(loiOverdue + loiDue).padStart(2, '0'),
      delta: loiOverdue > 0 ? `▲ ${loiOverdue} overdue` : 'on track',
      deltaTone: loiOverdue > 0 ? 'neg' : 'pos',
      sub: `${loiDue} due · ${loiOverdue} past timeline`,
    },
  };

  // Sites-in-motion overview combines stages — RBAC-filtered.
  const allMotion = [
    ...visibleDrafts.map(d => ({ id: d.id, code: d.code, name: d.name, city: d.city, stage: 'draft', days: d.days, owner: d.createdBy, when: d.visitDate, meta: 'visit ' + d.visitDate })),
    ...visibleShortlist.map(s => ({ id: s.code, code: s.code, name: s.name, city: s.city, stage: s.inReview ? 'inReview' : 'shortlist', days: 3, owner: s.createdBy, when: s.visitDate, meta: s.inReview ? 'in review' : 'awaiting details' })),
    ...visibleStaging.map(s => {
      const overdue = s.daysSinceApproval > s.expectedLoiDays && !s.loiUploaded;
      return { id: s.id, code: s.code, name: s.name, city: s.city, stage: s.pushed ? 'completed' : s.loiUploaded ? 'uploaded' : (overdue ? 'overdue' : 'staging'), days: s.daysSinceApproval, owner: s.createdBy, when: s.draftDate || s.approvedDate, meta: `LOI ${s.daysSinceApproval}/${s.expectedLoiDays}d` };
    }),
  ];
  // Apply stage filter chip
  const stageFiltered = stage === 'all' ? allMotion : allMotion.filter(r => {
    if (stage === 'staging') return ['staging','overdue','uploaded','completed'].includes(r.stage);
    if (stage === 'shortlist') return ['shortlist','inReview'].includes(r.stage);
    return r.stage === stage;
  });
  // Apply advanced (month / preset / range) filter
  const filteredMotion = stageFiltered.filter(r => {
    if (!r.when) return true;
    if (advanced.month) {
      return r.when.slice(0, 7) === advanced.month;
    }
    if (advanced.from || advanced.to) {
      if (advanced.from && r.when < advanced.from) return false;
      if (advanced.to && r.when > advanced.to) return false;
    }
    return true;
  });

  return (
    <div data-screen-label="01 Sites in motion" data-theme={dark ? 'dark' : 'light'} style={{
      width: '100%', height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--zm-bg)', color: 'var(--zm-fg)', overflow: 'hidden',
    }}>
      <TopBar
        user={{ name: 'Riya Sharma' }}
        role={role}
        dark={dark}
        onToggleDark={() => setDark(d => !d)}
        onNewPipeline={() => setShowNew(true)}
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        <Sidebar view={view} onView={setView} counts={counts} role={role} onRole={setRole}/>

        <main style={{
          flex: 1, overflowY: 'auto', padding: '24px 32px 64px',
          background: 'var(--zm-bg)',
          backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><path d='M40 0 L0 0 0 40' fill='none' stroke='" + (dark ? '%23E2E8F0' : '%23111827') + "' stroke-width='0.5' opacity='0.04'/></svg>\")",
          backgroundSize: '40px 40px',
        }}>
          {view === 'overview' && (
            <>
              <PageHeader
                file="№ 01"
                eyebrow="Overview"
                title="Sites in motion"
                lede={role === 'supervisor'
                  ? `Synced 2 min ago — all sites in your tenant. ${visibleDrafts.length + visibleShortlist.length + visibleStaging.length} files across draft, shortlist and staging.`
                  : `Synced 2 min ago — your sites, ${ME}. ${visibleDrafts.length + visibleShortlist.length + visibleStaging.length} files across draft, shortlist and staging.`}
                right={<>
                  <HeaderTag icon="clock" label="LIVE · 2M LAG"/>
                  <HeaderTag icon="shield" label={role === 'supervisor' ? 'TENANT SCOPE' : 'PERSONAL SCOPE'} tone="accent"/>
                </>}
              />

              <div style={{ marginBottom: 18 }}><MetricStrip metrics={metrics}/></div>

              <div style={{ marginBottom: 14 }}>
                <PipelineFilter
                  stage={stage} onStage={setStage}
                  counts={{ all: allMotion.length, draft: counts.pipeline, shortlist: counts.shortlist, staging: counts.staging }}
                  advanced={advanced} onAdvanced={setAdvanced}
                />
              </div>

              <MotionTable rows={filteredMotion} onOpen={(r) => {
                if (r.stage === 'draft') setView('pipeline');
                else if (['shortlist','inReview'].includes(r.stage)) setView('shortlist');
                else setView('staging');
              }}/>
            </>
          )}

          {view === 'pipeline' && (
            <DraftsView
              drafts={visibleDrafts}
              role={role}
              onApprove={onDraftApprove}
              onReject={onDraftReject}
              onArchive={onDraftArchive}
              onOpen={(d) => setOpenSite(buildDrawerSite({ ...d, stage: 'draft' }))}
            />
          )}

          {view === 'shortlist' && (
            <ShortlistQueue
              items={visibleShortlist}
              role={role}
              onView={(item) => setOpenSite(buildDrawerSite(item))}
              onAddDetails={onAddDetails}
              onApprove={onApproveShortlist}
            />
          )}

          {view === 'staging' && (
            <StagingView
              sites={visibleStaging}
              role={role}
              onUpload={onUploadLOI}
              onOpen={(site) => setOpenSite(buildDrawerSite(site))}
              onPush={onPushSite}
              onViewLOI={onViewLOI}
            />
          )}

          {view === 'archive' && role === 'supervisor' && (
            <ArchiveView
              archives={archive}
              onOpen={(a) => setOpenSite(buildDrawerSite({ ...a, stage: 'archived' }))}
            />
          )}
        </main>

        {openSite && <SiteDrawer site={openSite} onClose={() => setOpenSite(null)}/>}
      </div>

      {showNew && (
        <NewPipelineModal
          onClose={() => setShowNew(false)}
          onSubmit={(form) => {
            setShowNew(false);
            const id = 'site_' + Math.random().toString(36).slice(2, 10);
            setDrafts(prev => [{
              id, code: 'BT-' + (form.city.slice(0,3).toUpperCase()) + '-' + Math.floor(Math.random()*900+100),
              name: form.name, city: form.city, visitDate: form.visitDate, days: 0,
              createdBy: ME, stage: 'draft',
            }, ...prev]);
            showToast(`Pipeline submitted · ${form.name}. Supervisor notified.`);
          }}
        />
      )}

      {approving && (
        <LOITimelineModal
          site={approving}
          onCancel={() => setApproving(null)}
          onSubmit={onTimelineSubmit}
        />
      )}

      {rejecting && (
        <RejectReasonDialog
          draft={rejecting}
          onCancel={() => setRejecting(null)}
          onSubmit={onDraftRejectConfirm}
        />
      )}

      {detailing && (
        <AddDetailsForm
          item={detailing}
          onClose={() => setDetailing(null)}
          onSubmit={(formData) => onDetailsSubmit(detailing, formData)}
          onSaveDraft={(formData) => onDetailsSaveDraft(detailing, formData)}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--zm-fg)', color: '#fff',
          padding: '10px 16px', borderRadius: 10,
          boxShadow: 'var(--zm-shadow-pop)',
          fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 10, zIndex: 200,
          animation: 'zm-rise 240ms var(--zm-ease-emp)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: toast.tone === 'danger' ? '#F87171' : '#34D399' }}/>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

const MotionTable = ({ rows, onOpen }) => (
  <div style={{ background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--zm-shadow-1)' }}>
    <div style={{
      display: 'grid', gridTemplateColumns: '0.9fr 1.7fr 1fr 1fr 0.7fr 1.1fr 1.2fr',
      gap: 10, padding: '11px 16px', background: 'var(--zm-surface-2)',
      borderBottom: '1px solid var(--zm-line)',
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
      letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
    }}>
      <span>Code</span><span>Site</span><span>City</span><span>Owner</span><span>Days</span><span>Stage</span><span>Detail</span>
    </div>
    {rows.slice(0, 12).map(r => (
      <div key={r.id} onClick={() => onOpen(r)} className="zm-row" style={{
        display: 'grid', gridTemplateColumns: '0.9fr 1.7fr 1fr 1fr 0.7fr 1.1fr 1.2fr',
        gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--zm-line-faint)',
        background: r.stage === 'overdue' ? 'rgba(217,119,6,0.06)' : 'transparent',
        cursor: 'pointer', position: 'relative',
      }}>
        {r.stage === 'overdue' && <span style={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, background: '#D97706', borderRadius: 2 }}/>}
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{r.code}</span>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, color: 'var(--zm-fg)' }}>{r.name}</span>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}>{r.city}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Avatar name={r.owner} size={20}/>
          <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, color: 'var(--zm-fg-2)' }}>{r.owner}</span>
        </span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12.5, color: r.stage === 'overdue' ? '#B45309' : 'var(--zm-fg)' }}>{String(r.days).padStart(2,'0')}d</span>
        <span><StatusPill stage={r.stage}/></span>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, color: 'var(--zm-fg-3)' }}>{r.meta}</span>
      </div>
    ))}
    {rows.length === 0 && (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-body)', fontSize: 13 }}>
        No sites in this stage right now.
      </div>
    )}
  </div>
);

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
