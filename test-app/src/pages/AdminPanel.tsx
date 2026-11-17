import { useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, CircleHelp,
  Copy, Cpu, ExternalLink, Globe2, HardDrive, Layers3, LockKeyhole,
  Menu, MoreHorizontal, Plus, Radio, Search, Server, Settings2, Shield,
  ShieldCheck, TerminalSquare, Users, Waves, X,
} from 'lucide-react';
import './admin-panel.css';

type Section = 'Overview' | 'Apps' | 'Installed' | 'Activity' | 'Admins' | 'Settings';

const initialServices = [
  { name: 'Ditto Relay', id: 'relay', image: 'ghcr.io/imattau/ncc-server-relay', status: 'Running', detail: 'Public relay · Read & write', url: 'ncc://npub1ncc…/relay/', icon: Radio, tint: 'blue', published: true },
  { name: 'Npanel', id: 'npanel', image: 'ghcr.io/imattau/ncc-server-npanel', status: 'Running', detail: 'Nsite gateway · 18 sites', url: 'ncc://npub1ncc…/npanel/', icon: Layers3, tint: 'violet', published: true },
  { name: 'NCC Search', id: 'search', image: 'ghcr.io/imattau/ncc-server-search', status: 'Running', detail: 'Search index · Updated 4m ago', url: 'ncc://npub1ncc…/search/', icon: Search, tint: 'amber', published: true },
];

const catalog = [
  { name: 'Nostr Relay', category: 'NOSTR', description: 'A private or public relay for your community.', image: 'ghcr.io/ditto/ncc-relay', icon: Radio, tint: 'blue', meta: '1 container · 1 port' },
  { name: 'Nsite Gateway', category: 'PUBLISHING', description: 'Host Nostr websites on your own domains.', image: 'ghcr.io/soapbox/npanel', icon: Globe2, tint: 'violet', meta: '1 container · persistent storage' },
  { name: 'Community Chat', category: 'SOCIAL', description: 'A Nostr-powered home for your community.', image: 'ghcr.io/soapbox/ditto-web', icon: Waves, tint: 'green', meta: '1 container · 1 port' },
];

const adminRows = [
  { name: 'Alex Morgan', npub: 'npub1ncc…4k8x', state: 'You · owner', mark: 'AM', color: 'lime' },
  { name: 'Riley Chen', npub: 'npub1riley…8m2p', state: 'Active admin', mark: 'RC', color: 'blue' },
  { name: 'Sam Rivera', npub: 'npub1sam…9x1q', state: 'Invitation pending', mark: 'SR', color: 'peach' },
];

function IconBox({ icon: Icon, tint }: { icon: typeof Server; tint: string }) {
  return <span className={`panel-icon ${tint}`}><Icon size={19} strokeWidth={1.8} /></span>;
}

export default function AdminPanel() {
  const [section, setSection] = useState<Section>('Overview');
  const [showInstall, setShowInstall] = useState(false);
  const [selectedApp, setSelectedApp] = useState(catalog[0]);
  const [installed, setInstalled] = useState(initialServices);
  const [installing, setInstalling] = useState(false);
  const [published, setPublished] = useState(true);
  const [npub, setNpub] = useState('');
  const [invited, setInvited] = useState(false);
  const [connected, setConnected] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState('');

  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  };

  const startInstall = (app: typeof catalog[number]) => {
    setSelectedApp(app);
    setShowInstall(true);
  };

  const confirmInstall = () => {
    setInstalling(true);
    window.setTimeout(() => {
      const service = {
        name: selectedApp.name,
        id: selectedApp.name.toLowerCase().replaceAll(' ', '-'),
        image: selectedApp.image,
        status: 'Running',
        detail: 'Just installed · Health check passed',
        url: `ncc://npub1ncc…/${selectedApp.name.toLowerCase().replaceAll(' ', '-')}/`,
        icon: selectedApp.icon,
        tint: selectedApp.tint,
        published: false,
      };
      setInstalled((items) => [service, ...items]);
      setSection('Installed');
      setShowInstall(false);
      setInstalling(false);
      setPublished(false);
      notify(`${selectedApp.name} installed and healthy`);
    }, 1400);
  };

  const navItems: { label: Section; icon: typeof Server }[] = [
    { label: 'Overview', icon: Activity }, { label: 'Apps', icon: Layers3 },
    { label: 'Installed', icon: Server }, { label: 'Activity', icon: TerminalSquare },
    { label: 'Admins', icon: Users }, { label: 'Settings', icon: Settings2 },
  ];

  return (
    <div className="ncc-panel">
      <aside className={`panel-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <a className="panel-brand" href="/" aria-label="NCC Server home">
          <span className="panel-brand-mark"><Globe2 size={21} /></span>
          <span>NCC <i>/</i> SERVER</span>
        </a>
        <div className="panel-node">
          <span className="node-avatar"><Server size={17} /></span>
          <span className="node-copy"><strong>My community node</strong><small><b /> Online · 1.43.63.94</small></span>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">MANAGE</div>
        <nav aria-label="Panel navigation">
          {navItems.map(({ label, icon: Icon }) => <button key={label} className={`panel-nav-item ${section === label ? 'active' : ''}`} onClick={() => { setSection(label); setMobileNav(false); }}>
            <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
            {label === 'Installed' && <em>{installed.length}</em>}
          </button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-card"><div className="storage-top"><HardDrive size={15} /><span>Storage</span><span className="storage-value">42%</span></div><div className="storage-track"><i /></div><small>84 GB of 200 GB used</small></div>
          <button className="help-link" onClick={() => notify('Opening NCC Server operator guide')}><CircleHelp size={16} /> Operator guide <ArrowUpRight size={13} /></button>
          <div className="sidebar-version">NCC SERVER <span>PROTOTYPE</span></div>
        </div>
      </aside>

      <main className="panel-main">
        <header className="panel-topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu size={20} /></button>
          <div className="breadcrumbs"><span>My community node</span><b>/</b><strong>{section}</strong></div>
          <div className="topbar-right">
            <span className="prototype-tag"><i /> DEMO MODE</span>
            {connected ? <button className="operator-chip" onClick={() => setConnected(false)}><span className="operator-avatar">AM</span><span><strong>Alex Morgan</strong><small>npub1ncc…4k8x</small></span><ChevronDown size={14} /></button> : <button className="connect-button" onClick={() => setConnected(true)}><LockKeyhole size={15} /> Connect operator key</button>}
          </div>
        </header>

        <div className="panel-content">
          {section === 'Overview' && <>
            <div className="page-heading"><div><div className="eyebrow">MONDAY, NOVEMBER 17, 2026 <span>·</span> SERVER OVERVIEW</div><h1>Your server, at a glance.</h1><p>Everything running on your node, in one place.</p></div><button className="button-primary" onClick={() => { setSection('Apps'); }}><Plus size={16} /> Add a service</button></div>
            <div className="metric-grid">
              <div className="metric-card"><div className="metric-label">SERVER STATUS <span className="metric-icon mint"><ShieldCheck size={16} /></span></div><div className="metric-value"><i className="live-dot" /> All systems operational</div><div className="metric-foot">Last checked just now</div></div>
              <div className="metric-card"><div className="metric-label">RUNNING SERVICES <span className="metric-icon lilac"><Layers3 size={16} /></span></div><div className="metric-value">{installed.length}<small> / 8</small></div><div className="metric-foot">Across 4.2 GB memory</div></div>
              <div className="metric-card"><div className="metric-label">CPU USAGE <span className="metric-icon blue"><Cpu size={16} /></span></div><div className="metric-value">23<small>%</small></div><div className="mini-chart"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
              <div className="metric-card"><div className="metric-label">NOSTR ADMINS <span className="metric-icon peach"><Users size={16} /></span></div><div className="metric-value">3<small> keys</small></div><div className="metric-foot">2 active · 1 invitation pending</div></div>
            </div>
            <section className="content-section">
              <div className="section-heading"><div><h2>Your services</h2><p>Containers running on this node</p></div><button className="text-button" onClick={() => setSection('Installed')}>View all <ArrowUpRight size={14} /></button></div>
              <div className="service-list">{installed.slice(0, 3).map((service) => <div className="service-row" key={service.id}><IconBox icon={service.icon} tint={service.tint} /><div className="service-name"><strong>{service.name}</strong><small>{service.detail}</small></div><span className="status-pill"><i />{service.status}</span><button className="locator-link" onClick={() => notify('Locator copied to clipboard')}><span>{service.url}</span><Copy size={14} /></button><button className="icon-quiet" onClick={() => notify(`${service.name} actions`)} aria-label={`${service.name} actions`}><MoreHorizontal size={19} /></button></div>)}</div>
            </section>
            <div className="overview-bottom">
              <section className="content-section activity-panel"><div className="section-heading"><div><h2>Recent activity</h2><p>What’s been happening on your node</p></div><button className="text-button" onClick={() => setSection('Activity')}>Activity log <ArrowUpRight size={14} /></button></div>
                <div className="timeline"><div className="timeline-item"><span className="timeline-mark success"><Check size={13} /></span><div><strong>Npanel is healthy</strong><small>Health check passed · Npanel</small></div><time>2 min ago</time></div><div className="timeline-item"><span className="timeline-mark purple"><Radio size={13} /></span><div><strong>Service locator published</strong><small>Kind 30058 · relay.ditto.pub</small></div><time>2 min ago</time></div><div className="timeline-item"><span className="timeline-mark blue"><Users size={13} /></span><div><strong>Admin invitation sent</strong><small>npub1sam…9x1q · awaiting acceptance</small></div><time>1 hr ago</time></div></div>
              </section>
              <section className="publish-card"><div className="publish-orbit"><Radio size={21} /></div><div className="eyebrow">YOUR NODE ON NOSTR</div><h3>Discoverable by design.</h3><p>Your services are shared as signed NCC locators. You own the identity and control what gets published.</p><button className="publish-link" onClick={() => { setPublished(true); notify('All service locators are up to date'); }}>Review publications <ArrowUpRight size={14} /></button></section>
            </div>
          </>}

          {section === 'Apps' && <>
            <div className="page-heading"><div><div className="eyebrow">APP CATALOG <span>·</span> CURATED FOR NCC</div><h1>Give your server a new purpose.</h1><p>Choose a service. We’ll handle the containers, health checks, routing, and Nostr locator.</p></div><span className="catalog-count">{catalog.length} READY TO INSTALL</span></div>
            <div className="catalog-toolbar"><div className="catalog-search"><Search size={16} /><input aria-label="Search apps" placeholder="Find an app…" /></div><button className="filter-button">All categories <ChevronDown size={14} /></button><button className="package-button" onClick={() => notify('Package upload is planned for a later prototype')}><ArrowDownToLine size={15} /> Import package</button></div>
            <div className="catalog-grid">{catalog.map((app) => { const Icon = app.icon; return <article className="catalog-card" key={app.name}><div className="catalog-card-top"><IconBox icon={Icon} tint={app.tint} /><span className="category-tag">{app.category}</span></div><h3>{app.name}</h3><p>{app.description}</p><div className="catalog-meta"><span>{app.meta}</span><button onClick={() => notify(`${app.name}: package details`)}>Details <ArrowUpRight size={12} /></button></div><button className="catalog-install" onClick={() => startInstall(app)}><Plus size={15} /> Install service</button></article>; })}</div>
            <div className="catalog-note"><Shield size={17} /><span><strong>Reviewed packages.</strong> Catalog entries are curated and pinned to a specific image version. You’ll review ports, storage, and permissions before installing.</span><button onClick={() => notify('Package submission guide')}>How packages work <ArrowUpRight size={13} /></button></div>
          </>}

          {section === 'Installed' && <>
            <div className="page-heading"><div><div className="eyebrow">CONTAINER MANAGEMENT</div><h1>Installed services</h1><p>Monitor, manage, and publish the services on your node.</p></div><button className="button-primary" onClick={() => setSection('Apps')}><Plus size={16} /> Add a service</button></div>
            <div className="installed-list">{installed.map((service) => <article className="installed-card" key={service.id}><div className="installed-main"><IconBox icon={service.icon} tint={service.tint} /><div className="service-name"><div className="installed-title"><strong>{service.name}</strong><span className="status-pill"><i />{service.status}</span></div><small>{service.image}:stable</small></div><button className="icon-quiet" onClick={() => notify(`${service.name} actions`)} aria-label={`${service.name} actions`}><MoreHorizontal size={19} /></button></div><div className="installed-details"><div><span>PUBLIC ENDPOINT</span><strong>{service.url}</strong></div><div><span>HEALTH</span><strong className="health-good"><i /> Passing · checked 30s ago</strong></div><div><span>PUBLICATION</span><strong>{service.published && published ? 'Locator published' : 'Needs publishing'}</strong></div></div><div className="installed-actions"><button onClick={() => notify(`Showing ${service.name} logs`)}><TerminalSquare size={14} /> Logs</button><button onClick={() => notify(`${service.name} restarted`)}><Activity size={14} /> Restart</button><button onClick={() => { setPublished(true); notify(`${service.name} locator published`); }}><Radio size={14} /> {service.published && published ? 'Republish locator' : 'Publish locator'}</button><button className="external-action" onClick={() => notify('Endpoint copied')}><ExternalLink size={14} /> Open endpoint</button></div></article>)}</div>
          </>}

          {section === 'Admins' && <>
            <div className="page-heading"><div><div className="eyebrow">ACCESS CONTROL <span>·</span> NOSTR KEYS</div><h1>People who run this node.</h1><p>Admins sign in with their Nostr key. No passwords, no separate accounts.</p></div></div>
            <div className="admin-callout"><div className="callout-shield"><ShieldCheck size={20} /></div><div><strong>Access follows the operator key.</strong><p>Only npubs approved by an existing admin can manage containers, settings, or service publications.</p></div><span>KEY-BASED ACCESS</span></div>
            <section className="admin-section"><div className="section-heading"><div><h2>Node administrators <span className="count-chip">3</span></h2><p>Manage which Nostr keys can access this panel.</p></div></div><div className="admin-table"><div className="admin-table-head"><span>OPERATOR</span><span>ACCESS</span><span>ADDED</span><span /></div>{adminRows.map((admin, index) => <div className="admin-table-row" key={admin.npub}><div className="admin-person"><span className={`admin-avatar ${admin.color}`}>{admin.mark}</span><span><strong>{admin.name}</strong><small>{admin.npub} <button aria-label="Copy npub" onClick={() => notify('npub copied')}><Copy size={12} /></button></small></span></div><span className={`admin-state ${index === 2 ? 'pending' : ''}`}><i />{admin.state}</span><span className="admin-added">{index === 0 ? 'Server owner' : index === 1 ? 'Oct 24, 2026' : 'Today'}</span><button className="icon-quiet" aria-label="Admin actions" onClick={() => notify(index === 0 ? 'The owner key cannot be removed here' : 'Admin actions')}><MoreHorizontal size={18} /></button></div>)}</div></section>
            <section className="invite-card"><div className="invite-heading"><span className="invite-icon"><Plus size={18} /></span><div><h2>Invite an operator</h2><p>Add their public Nostr key. They’ll need to accept the sidecar invitation before managing services.</p></div></div><form onSubmit={(event) => { event.preventDefault(); if (!npub.startsWith('npub1')) { notify('Enter a valid npub1… public key'); return; } setInvited(true); setNpub(''); notify('Invitation sent · awaiting acceptance'); }}><label htmlFor="admin-npub">OPERATOR PUBLIC KEY</label><div className="invite-input-row"><input id="admin-npub" value={npub} onChange={(event) => setNpub(event.target.value)} placeholder="npub1…" /><button className="button-primary" type="submit"><Plus size={15} /> Send invitation</button></div><small><LockKeyhole size={12} /> Public key only. Never enter or share a private key here.</small>{invited && <div className="invite-success"><Check size={14} /> Invitation sent. It will appear as pending until accepted.</div>}</form></section>
            <div className="admin-footnote"><CircleHelp size={15} /><span>Admins are also provisioned for Npanel. Revoking a key here should remove its access from every supported NCC service.</span><button onClick={() => notify('Opening admin access documentation')}>Access guide <ArrowUpRight size={12} /></button></div>
          </>}

          {section === 'Activity' && <><div className="page-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h1>Activity on your node.</h1><p>Installs, operator access, and Nostr publications.</p></div><button className="filter-button">Last 7 days <ChevronDown size={14} /></button></div><div className="activity-full"><div className="activity-date">TODAY · NOVEMBER 17</div><div className="timeline-item"><span className="timeline-mark success"><Check size={13} /></span><div><strong>Npanel is healthy</strong><small>Health check passed · Npanel</small></div><time>2 min ago</time></div><div className="timeline-item"><span className="timeline-mark purple"><Radio size={13} /></span><div><strong>Service locator published</strong><small>Kind 30058 · relay.ditto.pub, primal.net</small></div><time>2 min ago</time></div><div className="timeline-item"><span className="timeline-mark blue"><Users size={13} /></span><div><strong>Admin invitation sent</strong><small>npub1sam…9x1q · awaiting acceptance</small></div><time>1 hr ago</time></div><div className="activity-date">NOVEMBER 16</div><div className="timeline-item"><span className="timeline-mark green"><Layers3 size={13} /></span><div><strong>NCC Search updated</strong><small>Image pulled · health check passed</small></div><time>Yesterday</time></div></div></>}

          {section === 'Settings' && <><div className="page-heading"><div><div className="eyebrow">NODE CONFIGURATION</div><h1>Settings for this server.</h1><p>Manage your public identity and service defaults.</p></div></div><div className="settings-grid"><section className="settings-card"><div className="settings-card-title"><Globe2 size={17} /><div><h2>Public identity</h2><p>How clients find this node on Nostr.</p></div></div><label>OPERATOR NPUB</label><div className="settings-readonly">npub1nccserver…4k8x <Copy size={14} /></div><label>PUBLIC ADDRESS</label><div className="settings-readonly">1.43.63.94</div><button className="text-button" onClick={() => notify('Identity is managed by the NCC sidecar')}>Manage identity <ArrowUpRight size={13} /></button></section><section className="settings-card"><div className="settings-card-title"><Radio size={17} /><div><h2>Publication relays</h2><p>Where signed NCC locators are published.</p></div></div><div className="relay-setting"><i className="relay-dot" /><span><strong>relay.ditto.pub</strong><small>wss://relay.ditto.pub</small></span><span className="relay-state">Connected</span></div><div className="relay-setting"><i className="relay-dot" /><span><strong>Primal</strong><small>wss://relay.primal.net</small></span><span className="relay-state">Connected</span></div><button className="text-button" onClick={() => notify('Relay configuration is managed by the NCC sidecar')}>Configure relays <ArrowUpRight size={13} /></button></section><section className="settings-card"><div className="settings-card-title"><Shield size={17} /><div><h2>Admin access</h2><p>Operators sign in with Nostr keys only.</p></div></div><div className="settings-inline"><span>Approved admin keys</span><strong>2 active</strong></div><div className="settings-inline"><span>Pending invitations</span><strong>1 pending</strong></div><button className="text-button" onClick={() => setSection('Admins')}>Manage operators <ArrowUpRight size={13} /></button></section><section className="settings-card"><div className="settings-card-title"><HardDrive size={17} /><div><h2>Container defaults</h2><p>Baseline settings for new installs.</p></div></div><div className="settings-inline"><span>Restart policy</span><strong>Unless stopped</strong></div><div className="settings-inline"><span>Backend binding</span><strong>Loopback only</strong></div><div className="settings-inline"><span>Image versions</span><strong>Pinned releases</strong></div></section></div></>}
        </div>
      </main>

      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      {showInstall && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !installing) setShowInstall(false); }}><section className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title"><div className="modal-top"><div className="eyebrow">NEW SERVICE <span>·</span> STEP 1 OF 2</div><button className="icon-quiet" onClick={() => setShowInstall(false)} aria-label="Close" disabled={installing}><X size={19} /></button></div><h2 id="install-title">Install {selectedApp.name}</h2><p className="modal-intro">Review what this package will add to your server.</p><div className="modal-app"><IconBox icon={selectedApp.icon} tint={selectedApp.tint} /><div><strong>{selectedApp.name}</strong><small>{selectedApp.description}</small></div><span className="verified-tag"><ShieldCheck size={13} /> REVIEWED</span></div><div className="install-spec"><div><span>CONTAINER IMAGE</span><strong>{selectedApp.image}:1.4.2</strong></div><div><span>PUBLIC ENDPOINT</span><strong>https://1.43.63.94:8450</strong></div><div><span>DATA STORAGE</span><strong>/srv/ncc/apps/{selectedApp.name.toLowerCase().replaceAll(' ', '-')} · persistent</strong></div><div><span>NETWORK ACCESS</span><strong>One public HTTPS port · backend loopback only</strong></div></div><div className="install-security"><LockKeyhole size={15} /><span>Secrets stay on this server. The service locator publishes only its public endpoint.</span></div><div className="modal-buttons"><button className="button-secondary" onClick={() => setShowInstall(false)} disabled={installing}>Cancel</button><button className="button-primary" onClick={confirmInstall} disabled={installing}>{installing ? <><span className="button-spinner" /> Pulling image…</> : <><Plus size={15} /> Install service</>}</button></div><div className="install-step-hint">{installing ? 'Pulling image · Starting container · Checking health · Publishing locator' : 'Next: confirm install and publish a signed NCC locator.'}</div></section></div>}
      {notice && <div className="toast-note"><Check size={15} />{notice}</div>}
    </div>
  );
}
