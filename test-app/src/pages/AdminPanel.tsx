import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNostrLogin } from '@nostrify/react/login';
import {
  Activity, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, CircleAlert,
  CircleHelp, Copy, ExternalLink, Globe2, HardDrive, KeyRound, Layers3,
  LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, Radio, RefreshCw, Search,
  Server, Settings2, Shield, ShieldCheck, TerminalSquare, Trash2, Users, Waves, X,
  type LucideIcon,
} from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import {
  copyText,
  loadPanelConfig,
  loadPanelSnapshot,
  operatorPubkeyFromNpub,
  pubkeyFromAdminInput,
  type PanelActivity,
  type PanelConfig,
  type PanelService,
  type PanelSnapshot,
} from '@/lib/nccPanel';
import {
  PanelApiError,
  addPanelAdmin,
  listPanelAdmins,
  removePanelAdmin,
  resolvePanelApiBase,
  type PanelAdmin,
} from '@/lib/nccPanelApi';
import './admin-panel.css';

type Section = 'Overview' | 'Apps' | 'Installed' | 'Activity' | 'Admins' | 'Settings';
type AdminAccess = 'idle' | 'checking' | 'admin' | 'denied' | 'unavailable';
type AdminListState = 'idle' | 'ready' | 'error';
type Tint = 'blue' | 'violet' | 'amber' | 'green';
type SignInMethod = 'extension' | 'bunker';

interface ServiceMeta {
  label: string;
  description: string;
  route: string;
  tint: Tint;
  icon: LucideIcon;
  order: number;
}

const SERVICE_META: Record<string, ServiceMeta> = {
  addr: { label: 'Web (legacy)', description: 'Older welcome-page record', route: '', tint: 'green', icon: Globe2, order: 0 },
  web: { label: 'Web', description: 'Public welcome page', route: '', tint: 'green', icon: Globe2, order: 0 },
  relay: { label: 'Nostr Relay', description: 'Public relay · read & write', route: 'relay', tint: 'blue', icon: Radio, order: 1 },
  ditto: { label: 'Ditto', description: 'Community web client', route: 'ditto', tint: 'violet', icon: Waves, order: 2 },
  search: { label: 'NCC Search', description: 'Federated search index', route: 'search', tint: 'amber', icon: Search, order: 3 },
  npanel: { label: 'Npanel', description: 'Nsite gateway', route: 'npanel', tint: 'violet', icon: Layers3, order: 4 },
  admin: { label: 'Admin Panel', description: 'This read-only panel', route: 'admin', tint: 'green', icon: Shield, order: 5 },
  manager: { label: 'Manager', description: 'Identity manager', route: 'manager', tint: 'green', icon: Server, order: 6 },
};

const UNKNOWN_SERVICE: ServiceMeta = {
  label: 'NCC service',
  description: 'Published by this node',
  route: '',
  tint: 'green',
  icon: Server,
  order: 99,
};

function serviceMeta(id: string): ServiceMeta {
  return SERVICE_META[id] ?? { ...UNKNOWN_SERVICE, label: id, route: id };
}

const catalog = [
  { name: 'Nostr Relay', category: 'NOSTR', description: 'A private or public relay for your community.', image: 'ghcr.io/ditto/ncc-relay', icon: Radio, tint: 'blue' as Tint, meta: '1 container · 1 port' },
  { name: 'Nsite Gateway', category: 'PUBLISHING', description: 'Host Nostr websites on your own domains.', image: 'ghcr.io/soapbox/npanel', icon: Globe2, tint: 'violet' as Tint, meta: '1 container · persistent storage' },
  { name: 'Community Chat', category: 'SOCIAL', description: 'A Nostr-powered home for your community.', image: 'ghcr.io/soapbox/ditto-web', icon: Waves, tint: 'green' as Tint, meta: '1 container · 1 port' },
];

const navItems: { label: Section; icon: LucideIcon }[] = [
  { label: 'Overview', icon: Activity },
  { label: 'Apps', icon: Layers3 },
  { label: 'Installed', icon: Server },
  { label: 'Activity', icon: TerminalSquare },
  { label: 'Admins', icon: Users },
  { label: 'Settings', icon: Settings2 },
];

function IconBox({ icon: Icon, tint }: { icon: LucideIcon; tint: string }) {
  return (
    <span className={`panel-icon ${tint}`}>
      <Icon size={19} strokeWidth={1.8} />
    </span>
  );
}

function shortNpub(npub: string): string {
  return npub.length > 20 ? `${npub.slice(0, 11)}…${npub.slice(-6)}` : npub;
}

function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} hr ago`;
  return `${Math.round(diff / 86400)} d ago`;
}

function durationLabel(seconds: number): string {
  const value = Math.abs(Math.round(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function expiryLabel(service: PanelService): string {
  if (service.expiresAt === null) return 'No expiry published';
  const remaining = service.expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return `Expired ${durationLabel(remaining)} ago`;
  return `Expires in ${durationLabel(remaining)}`;
}

function statusCopy(service: PanelService): { label: string; tone: string } {
  switch (service.status) {
    case 'published':
      return { label: 'Published', tone: '' };
    case 'expired':
      return { label: 'Expired', tone: 'warning' };
    case 'anchor-only':
      return { label: 'Anchor only', tone: 'muted' };
    case 'locator-only':
      return { label: 'Locator only', tone: 'muted' };
  }
}

function endpointHost(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

function safeHref(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function signerLabel(type: string | undefined): string {
  switch (type) {
    case 'extension':
      return 'NIP-07 signer';
    case 'bunker':
      return 'NIP-46 signer';
    case 'nsec':
      return 'Local key';
    default:
      return 'Operator key';
  }
}

function addedLabel(createdAt: string | null): string {
  if (!createdAt) return 'Not recorded';
  const iso = createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function initials(npub: string): string {
  return npub.slice(-2).toUpperCase();
}

function activityGroups(activity: PanelActivity[]): { label: string; items: PanelActivity[] }[] {
  const groups = new Map<string, PanelActivity[]>();

  for (const item of activity) {
    const label = new Date(item.createdAt * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const existing = groups.get(label) ?? [];
    existing.push(item);
    groups.set(label, existing);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function ActivityRow({ item }: { item: PanelActivity }) {
  const meta = serviceMeta(item.serviceId);
  const locator = item.kind === 30058;

  return (
    <div className="timeline-item">
      <span className={`timeline-mark ${locator ? 'purple' : 'blue'}`}>
        {locator ? <Radio size={13} /> : <Layers3 size={13} />}
      </span>
      <div>
        <strong>{locator ? 'Locator refreshed' : 'Service record published'} · {meta.label}</strong>
        <small>kind {item.kind} · signed by the operator key</small>
      </div>
      <time>{relativeTime(item.createdAt)}</time>
    </div>
  );
}

interface OperatorGateProps {
  config: PanelConfig | null;
  operatorNpub: string;
  signerNpub: string | null;
  access: AdminAccess;
  localKeyOnly: boolean;
  busy: SignInMethod | null;
  error: string;
  bunkerUri: string;
  onBunkerUri: (value: string) => void;
  onExtension: () => void;
  onBunker: () => void;
  onSignOut: () => void;
  onCopy: (value: string, label: string) => void;
}

function OperatorGate({
  config, operatorNpub, signerNpub, access, localKeyOnly, busy, error, bunkerUri,
  onBunkerUri, onExtension, onBunker, onSignOut, onCopy,
}: OperatorGateProps) {
  const otherSigner = Boolean(signerNpub && signerNpub !== operatorNpub);

  return (
    <div className="ncc-panel gate-shell">
      <main className="gate-main">
        <section className="gate-card" aria-labelledby="gate-title">
          <div className="gate-brand">
            <span className="panel-brand-mark"><Globe2 size={21} /></span>
            <span>NCC <i>/</i> SERVER</span>
            <span className="prototype-tag"><i /> OPERATOR ONLY</span>
          </div>

          <div className="gate-shield"><ShieldCheck size={24} /></div>
          <h1 id="gate-title">Admin sign-in</h1>

          {config === null && (
            <>
              <p className="gate-intro">Reading the node identity before opening the panel.</p>
              <div className="gate-loading" role="status"><span className="button-spinner dark" /> Reading ncc-config.json…</div>
            </>
          )}

          {config !== null && !config.npub && (
            <>
              <p className="gate-intro">This build could not resolve the node's operator key. Open the panel over <code>ncc://</code> or make sure the node serves <code>/ncc-config.json</code>.</p>
              <div className="gate-note error" role="alert">
                <CircleAlert size={14} />
                <span>Node identity is not published yet. Deploy the current web build and re-run the host bootstrap, then reload this page.</span>
              </div>
            </>
          )}

          {config !== null && config.npub && (
            <>
              <p className="gate-intro">
                This panel reads the NCC records your node publishes and manages its admin keys. It opens for the
                node operator and for any key on the node's admin list.
              </p>

              <div className="gate-operator">
                <span>NODE OPERATOR</span>
                <strong>{shortNpub(operatorNpub)}</strong>
              </div>

              {localKeyOnly ? (
                <>
                  <div className="gate-note warning" role="alert">
                    <CircleAlert size={14} />
                    <span>A local secret key is signed in. This panel only accepts a NIP-07 extension or a NIP-46 remote signer.</span>
                  </div>
                  <div className="gate-actions">
                    <button className="button-secondary" type="button" onClick={onSignOut}>
                      <LogOut size={14} /> Disconnect this key
                    </button>
                    <button className="button-secondary" type="button" onClick={() => onCopy(operatorNpub, 'Operator npub')}>
                      <Copy size={14} /> Copy operator npub
                    </button>
                  </div>
                </>
              ) : otherSigner && signerNpub ? (
                <>
                  {access === 'checking' ? (
                    <div className="gate-loading" role="status">
                      <span className="button-spinner dark" /> Checking this key against the node's admin list…
                    </div>
                  ) : (
                    <div className="gate-note warning" role="alert">
                      <CircleAlert size={14} />
                      <span>
                        {access === 'denied'
                          ? 'A signer is connected, but its key is not an admin for this node.'
                          : 'This key could not be verified with the node admin API. Only an active admin key can open this panel.'}
                      </span>
                    </div>
                  )}
                  <div className="gate-identity">
                    <span>YOUR SIGNER</span>
                    <strong>{shortNpub(signerNpub)}</strong>
                  </div>
                  <div className="gate-actions">
                    <button className="button-secondary" type="button" onClick={onSignOut}>
                      <LogOut size={14} /> Disconnect this key
                    </button>
                    <button className="button-secondary" type="button" onClick={() => onCopy(operatorNpub, 'Operator npub')}>
                      <Copy size={14} /> Copy operator npub
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button className="button-primary gate-extension" type="button" onClick={onExtension} disabled={busy !== null}>
                    <KeyRound size={16} />
                    {busy === 'extension' ? 'Waiting for NIP-07 extension…' : 'Sign in with NIP-07 extension'}
                  </button>

                  <div className="gate-divider"><span>or a NIP-46 remote signer</span></div>

                  <form onSubmit={(event) => { event.preventDefault(); onBunker(); }}>
                    <label htmlFor="bunker-uri">BUNKER URI</label>
                    <div className="invite-input-row">
                      <input
                        id="bunker-uri"
                        value={bunkerUri}
                        onChange={(event) => onBunkerUri(event.target.value)}
                        placeholder="bunker://…"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy !== null}
                      />
                      <button className="button-secondary" type="submit" disabled={busy !== null}>
                        {busy === 'bunker' ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                  </form>

                  {error && (
                    <div className="gate-note error" role="alert">
                      <CircleAlert size={14} />
                      <span>{error}</span>
                    </div>
                  )}

                  <p className="gate-foot">
                    <LockKeyhole size={12} />
                    Your signer approves this client, and every admin change is signed as a NIP-98 request.
                    Inside NCC Browser use a NIP-46 signer; extensions usually load only on http(s) pages.
                  </p>
                </>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default function AdminPanel() {
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const login = useLoginActions();

  const [config, setConfig] = useState<PanelConfig | null>(null);
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [renderedAt] = useState(() => Date.now());
  const [refreshToken, setRefreshToken] = useState(0);

  const [section, setSection] = useState<Section>('Overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState('');
  const [appQuery, setAppQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState<typeof catalog[number] | null>(null);

  const [signInBusy, setSignInBusy] = useState<SignInMethod | null>(null);
  const [signInError, setSignInError] = useState('');
  const [bunkerUri, setBunkerUri] = useState('');

  const [verified, setVerified] = useState<{ pubkey: string; access: 'admin' | 'denied' | 'unavailable' } | null>(null);
  const [admins, setAdmins] = useState<PanelAdmin[] | null>(null);
  const [adminsState, setAdminsState] = useState<AdminListState>('idle');
  const [adminsError, setAdminsError] = useState('');
  const [adminsToken, setAdminsToken] = useState(0);
  const [adminBusy, setAdminBusy] = useState(false);
  const [inviteNpub, setInviteNpub] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteDone, setInviteDone] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const operatorNpub = config?.npub ?? null;
  const operatorPubkey = useMemo(() => operatorPubkeyFromNpub(operatorNpub), [operatorNpub]);
  const signerPubkey = user?.pubkey?.toLowerCase() ?? null;
  const signerNpub = useMemo(
    () => (signerPubkey ? nip19.npubEncode(signerPubkey) : null),
    [signerPubkey],
  );
  const signerType = logins[0]?.type;
  const supportedSigner = signerType === 'extension' || signerType === 'bunker';
  const localKeyOnly = signerType === 'nsec';
  const isOperator = Boolean(operatorPubkey && signerPubkey && operatorPubkey === signerPubkey);
  const apiBase = useMemo(() => resolvePanelApiBase(config?.panelApi ?? null), [config]);
  const access: AdminAccess = isOperator
    ? 'idle'
    : !config
      ? 'checking'
      : !apiBase
        ? 'unavailable'
        : verified && verified.pubkey === signerPubkey
          ? verified.access
          : 'checking';
  const authorized = Boolean(
    supportedSigner && signerPubkey && (isOperator || access === 'admin'),
  );

  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  };

  const copy = async (value: string, label: string) => {
    const copied = await copyText(value);
    notify(copied ? `${label} copied` : 'Copy failed — select the value manually');
  };

  useEffect(() => {
    const controller = new AbortController();
    loadPanelConfig(controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setConfig(loaded);
    });
    return () => controller.abort();
  }, []);

  // The operator is already named by the node config, so an operator session
  // costs no extra signature. Any other key has to prove it is on the node's
  // admin list before the panel opens.
  useEffect(() => {
    if (!supportedSigner || !signerPubkey || isOperator) return;
    if (!apiBase || !user) return;

    const controller = new AbortController();

    listPanelAdmins(apiBase, user.signer, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setAdmins(result.admins);
        setAdminsState('ready');
        setVerified({ pubkey: signerPubkey, access: 'admin' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setVerified({
          pubkey: signerPubkey,
          access: error instanceof PanelApiError && error.status === 403 ? 'denied' : 'unavailable',
        });
      });

    return () => controller.abort();
  }, [supportedSigner, signerPubkey, isOperator, apiBase, user]);

  // The node admin list is loaded once per session, on demand: opening the
  // Admins section or retrying after an error asks the signer to sign one
  // NIP-98 GET.
  useEffect(() => {
    if (section !== 'Admins' || !authorized || admins !== null) return;
    if (!apiBase || !user) return;

    const controller = new AbortController();

    listPanelAdmins(apiBase, user.signer, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setAdmins(result.admins);
        setAdminsState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAdminsState('error');
        setAdminsError(error instanceof Error ? error.message : 'Could not read the admin list');
      });

    return () => controller.abort();
  }, [section, authorized, admins, apiBase, user, adminsToken]);

  useEffect(() => {
    if (!config || !operatorPubkey || !authorized) return;

    const controller = new AbortController();

    loadPanelSnapshot(operatorPubkey, config.relays, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setSnapshot(loaded);
        setLoadedAt(Date.now());
        setRecordsError('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRecordsError(error instanceof Error ? error.message : 'Could not read NCC records');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });

    return () => controller.abort();
  }, [config, operatorPubkey, authorized, refreshToken]);

  const handleExtension = async () => {
    setSignInError('');
    setSignInBusy('extension');
    try {
      await login.extension();
    } catch (error) {
      setSignInError(
        error instanceof Error && error.message
          ? `NIP-07 sign-in failed: ${error.message}`
          : 'No NIP-07 extension answered. Try a NIP-46 remote signer below.',
      );
    } finally {
      setSignInBusy(null);
    }
  };

  const handleBunker = async () => {
    setSignInError('');
    const uri = bunkerUri.trim();

    if (!uri.startsWith('bunker://')) {
      setSignInError('Enter the bunker:// URI from your remote signer.');
      return;
    }

    setSignInBusy('bunker');
    try {
      await login.bunker(uri);
      setBunkerUri('');
    } catch (error) {
      setSignInError(
        error instanceof Error && error.message
          ? `NIP-46 sign-in failed: ${error.message}`
          : 'The remote signer did not accept this client.',
      );
    } finally {
      setSignInBusy(null);
    }
  };

  const handleSignOut = async () => {
    await login.logout();
    setSnapshot(null);
    setRecordsError('');
    setLoadedAt(null);
    setSection('Overview');
    setVerified(null);
    setAdmins(null);
    setAdminsState('idle');
    setAdminsError('');
    setInviteNpub('');
    setInviteError('');
    setInviteDone('');
    setConfirmRemove(null);
  };

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    setInviteError('');
    setInviteDone('');

    const value = inviteNpub.trim();
    if (!pubkeyFromAdminInput(value)) {
      setInviteError('Enter a valid npub (npub1…) or 64-character hex public key.');
      return;
    }
    if (!apiBase || !user) {
      setInviteError('The node admin API is not available.');
      return;
    }

    setAdminBusy(true);
    try {
      const result = await addPanelAdmin(apiBase, user.signer, value);
      setAdmins(result.admins);
      setAdminsState('ready');
      setInviteNpub('');
      setConfirmRemove(null);
      const message = result.added
        ? `Key added${result.inviteSent ? ' and the sidecar sent an invite' : ''}.`
        : 'That key is already an admin.';
      setInviteDone(message);
      notify(message);
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not add the key');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleRemove = async (pubkey: string) => {
    if (!apiBase || !user) return;

    if (confirmRemove !== pubkey) {
      setConfirmRemove(pubkey);
      setInviteError('');
      setInviteDone('');
      notify('Click remove again to confirm');
      return;
    }

    setAdminBusy(true);
    setInviteError('');
    try {
      const result = await removePanelAdmin(apiBase, user.signer, pubkey);
      setAdmins(result.admins);
      setAdminsState('ready');
      setInviteDone('Admin key removed.');
      notify('Admin key removed');
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not remove the key');
    } finally {
      setAdminBusy(false);
      setConfirmRemove(null);
    }
  };

  if (!authorized || !operatorNpub) {
    return (
      <OperatorGate
        config={config}
        operatorNpub={operatorNpub ?? ''}
        signerNpub={signerNpub}
        access={access}
        localKeyOnly={localKeyOnly}
        busy={signInBusy}
        error={signInError}
        bunkerUri={bunkerUri}
        onBunkerUri={setBunkerUri}
        onExtension={handleExtension}
        onBunker={handleBunker}
        onSignOut={handleSignOut}
        onCopy={copy}
      />
    );
  }

  const services = [...(snapshot?.services ?? [])].sort((a, b) => {
    const left = serviceMeta(a.id);
    const right = serviceMeta(b.id);
    return left.order === right.order ? left.label.localeCompare(right.label) : left.order - right.order;
  });
  const loadingRecords = refreshing || (snapshot === null && !recordsError);
  const refresh = () => {
    setRecordsError('');
    setRefreshing(true);
    setRefreshToken((value) => value + 1);
  };
  const publishedCount = services.filter((service) => service.status === 'published').length;
  const expiredCount = services.filter((service) => service.status === 'expired').length;
  const connectedRelays = snapshot?.relays.filter((relay) => relay.connected).length ?? 0;
  const relayTotal = config?.relays.length ?? 0;
  const newestExpiry = services
    .filter((service) => service.status === 'published' && service.expiresAt !== null)
    .reduce<number | null>((soonest, service) => {
      if (service.expiresAt === null) return soonest;
      return soonest === null || service.expiresAt < soonest ? service.expiresAt : soonest;
    }, null);
  const locatorTtl = services.find((service) => service.ttlSeconds !== null)?.ttlSeconds ?? null;
  const nowSeconds = Math.floor((loadedAt ?? renderedAt) / 1000);

  const connectionSummary = loadingRecords
    ? 'Reading records…'
    : recordsError
      ? 'Records unavailable'
      : services.length === 0
        ? 'No records found'
        : expiredCount > 0
          ? `${expiredCount} locator${expiredCount === 1 ? '' : 's'} expired`
          : 'All locators fresh';

  const publicHosts = Array.from(
    new Set(
      services
        .map((service) => endpointHost(service.endpoint))
        .filter((host): host is string => host !== null),
    ),
  );

  const filteredCatalog = catalog.filter((app) =>
    `${app.name} ${app.category} ${app.description}`.toLowerCase().includes(appQuery.trim().toLowerCase()),
  );

  const adminRows: PanelAdmin[] = admins ?? (operatorNpub
    ? [{ npub: operatorNpub, pubkey: operatorPubkey ?? '', status: 'active', createdAt: null }]
    : []);
  const apiAvailable = Boolean(apiBase);
  const adminsLoading = Boolean(apiAvailable && authorized && admins === null && adminsState !== 'error');
  const canManageAdmins = Boolean(apiAvailable && authorized && user && admins !== null);

  const groups = activityGroups(snapshot?.activity ?? []);
  const recentActivity = snapshot?.activity.slice(0, 3) ?? [];

  return (
    <div className="ncc-panel">
      <aside className={`panel-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <a className="panel-brand" href="/" aria-label="NCC Server home">
          <span className="panel-brand-mark"><Globe2 size={21} /></span>
          <span>NCC <i>/</i> SERVER</span>
        </a>

        <div className="panel-node" title="Node identity comes from ncc-config.json or the ncc:// address">
          <span className="node-avatar"><Server size={17} /></span>
          <span className="node-copy">
            <strong>NCC node</strong>
            <small><b /> {shortNpub(operatorNpub)} · {services.length} services</small>
          </span>
          <ChevronDown size={15} />
        </div>

        <div className="nav-caption">MANAGE</div>
        <nav aria-label="Panel navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`panel-nav-item ${section === label ? 'active' : ''}`}
              onClick={() => { setSection(label); setMobileNav(false); }}
            >
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Installed' && <em>{services.length}</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="storage-card">
            <div className="storage-top"><HardDrive size={15} /><span>Storage</span><span className="storage-value">—</span></div>
            <div className="storage-track"><i style={{ width: '0%' }} /></div>
            <small>Host metrics are not collected in this build</small>
          </div>
          <a
            className="help-link"
            href="https://github.com/imattau/ncc-server/blob/main/docs/admin-panel.md"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={16} /> Operator guide <ArrowUpRight size={13} />
          </a>
          <div className="sidebar-version">NCC SERVER <span>LIVE</span></div>
        </div>
      </aside>

      <main className="panel-main">
        <header className="panel-topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu size={20} /></button>
          <div className="breadcrumbs"><span>NCC node</span><b>/</b><strong>{section}</strong></div>
          <div className="topbar-right">
            <span className="prototype-tag"><i /> LIVE</span>
            <span className="operator-chip" title={`Signed in as ${signerLabel(signerType)}`}>
              <span className="operator-avatar">{initials(signerNpub ?? operatorNpub)}</span>
              <span><strong>{signerLabel(signerType)}</strong><small>{shortNpub(signerNpub ?? operatorNpub)}</small></span>
              <button className="icon-quiet" type="button" onClick={handleSignOut} title="Sign out" aria-label="Sign out">
                <LogOut size={14} />
              </button>
            </span>
          </div>
        </header>

        <div className="panel-content">
          {(loadingRecords || recordsError) && (
            <div className={`panel-banner ${recordsError ? 'error' : ''}`} role="status">
              {recordsError ? <CircleAlert size={14} /> : <RefreshCw size={14} className="spin" />}
              <span>{recordsError ? `Could not read NCC records: ${recordsError}` : 'Reading published NCC records from your relays…'}</span>
            </div>
          )}

          {section === 'Overview' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {new Date(renderedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    <span>·</span> SERVER OVERVIEW
                  </div>
                  <h1>Your server, at a glance.</h1>
                  <p>Everything this node publishes, read live from your relays.</p>
                </div>
                <div className="heading-actions">
                  <button className="button-secondary" onClick={refresh} disabled={loadingRecords}>
                    <RefreshCw size={15} className={loadingRecords ? 'spin' : undefined} /> Refresh
                  </button>
                  <button className="button-primary" onClick={() => setSection('Apps')}><Plus size={16} /> Add a service</button>
                </div>
              </div>

              <div className="metric-grid">
                <div className="metric-card">
                  <div className="metric-label">PUBLICATION STATUS <span className="metric-icon mint"><ShieldCheck size={16} /></span></div>
                  <div className="metric-value"><i className="live-dot" /> {connectionSummary}</div>
                  <div className="metric-foot">Last checked {loadedAt ? new Date(loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">SERVICES PUBLISHED <span className="metric-icon lilac"><Layers3 size={16} /></span></div>
                  <div className="metric-value">{services.length}<small> records</small></div>
                  <div className="metric-foot">{publishedCount} fresh locator{publishedCount === 1 ? '' : 's'} · kind 30059</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">RELAY DELIVERY <span className="metric-icon blue"><Radio size={16} /></span></div>
                  <div className="metric-value">{connectedRelays}<small> / {relayTotal} relays</small></div>
                  <div className="metric-foot">Queried live from this browser</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">LOCATOR FRESHNESS <span className="metric-icon peach"><Activity size={16} /></span></div>
                  <div className="metric-value">
                    {newestExpiry === null ? '—' : durationLabel(newestExpiry - nowSeconds)}
                    <small> until expiry</small>
                  </div>
                  <div className="metric-foot">{locatorTtl === null ? 'No locator TTL published' : `${durationLabel(locatorTtl)} locator TTL`}</div>
                </div>
              </div>

              <section className="content-section">
                <div className="section-heading">
                  <div><h2>Your services</h2><p>Published NCC records for this node</p></div>
                  <button className="text-button" onClick={() => setSection('Installed')}>View all <ArrowUpRight size={14} /></button>
                </div>

                {loadingRecords && services.length === 0 ? (
                  <div className="empty-state">Reading published services…</div>
                ) : services.length === 0 ? (
                  <div className="empty-state">No NCC service records were found on the configured relays.</div>
                ) : (
                  <div className="service-list">
                    {services.slice(0, 3).map((service) => {
                      const meta = serviceMeta(service.id);
                      const status = statusCopy(service);
                      return (
                        <div className="service-row" key={service.id}>
                          <IconBox icon={meta.icon} tint={meta.tint} />
                          <div className="service-name"><strong>{meta.label}</strong><small>{meta.description}</small></div>
                          <span className={`status-pill ${status.tone}`}><i />{status.label}</span>
                          <button
                            className="locator-link"
                            onClick={() => service.endpoint && copy(service.endpoint, 'Endpoint')}
                            disabled={!service.endpoint}
                            title={service.endpoint ?? 'No endpoint published'}
                          >
                            <span>{service.endpoint ?? 'No endpoint'}</span><Copy size={14} />
                          </button>
                          <button className="icon-quiet" disabled aria-label={`${meta.label} actions (inactive)`} title="Container controls are inactive in this read-only build">
                            <MoreHorizontal size={19} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <div className="overview-bottom">
                <section className="content-section activity-panel">
                  <div className="section-heading">
                    <div><h2>Recent activity</h2><p>Record timestamps published on your relays</p></div>
                    <button className="text-button" onClick={() => setSection('Activity')}>Activity log <ArrowUpRight size={14} /></button>
                  </div>
                  {recentActivity.length === 0 ? (
                    <p className="empty-note">
                      {loadingRecords ? 'Reading publication history…' : 'No publication history found on the configured relays.'}
                    </p>
                  ) : (
                    <div className="timeline">
                      {recentActivity.map((item) => <ActivityRow key={`${item.kind}-${item.serviceId}`} item={item} />)}
                    </div>
                  )}
                </section>

                <section className="publish-card">
                  <div className="publish-orbit"><Radio size={21} /></div>
                  <div className="eyebrow">YOUR NODE ON NOSTR</div>
                  <h3>Discoverable by design.</h3>
                  <p>
                    {loadingRecords
                      ? 'Reading published records from your relays…'
                      : services.length === 0
                        ? 'No NCC records were found on the configured relays.'
                        : `${publishedCount} of ${services.length} services publish a fresh locator, signed by the operator key.`}
                  </p>
                  <button className="publish-link" onClick={() => setSection('Installed')}>Review publications <ArrowUpRight size={14} /></button>
                </section>
              </div>
            </>
          )}

          {section === 'Apps' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">APP CATALOG <span>·</span> READ-ONLY PREVIEW</div>
                  <h1>Give your server a new purpose.</h1>
                  <p>Provisioning is inactive in this build. You can review what each package would add.</p>
                </div>
                <span className="catalog-count">{filteredCatalog.length} READY TO REVIEW</span>
              </div>

              <div className="catalog-toolbar">
                <div className="catalog-search">
                  <Search size={16} />
                  <input
                    aria-label="Search apps"
                    placeholder="Find an app…"
                    value={appQuery}
                    onChange={(event) => setAppQuery(event.target.value)}
                  />
                </div>
                <button className="filter-button" disabled title="Category filters are inactive in this build">All categories <ChevronDown size={14} /></button>
                <button className="package-button" disabled title="Package import is inactive in this build"><ArrowDownToLine size={15} /> Import package</button>
              </div>

              <div className="catalog-grid">
                {filteredCatalog.map((app) => {
                  const Icon = app.icon;
                  return (
                    <article className="catalog-card" key={app.name}>
                      <div className="catalog-card-top">
                        <IconBox icon={Icon} tint={app.tint} />
                        <span className="category-tag">{app.category}</span>
                      </div>
                      <h3>{app.name}</h3>
                      <p>{app.description}</p>
                      <div className="catalog-meta">
                        <span>{app.meta}</span>
                        <button onClick={() => setSelectedApp(app)}>Details <ArrowUpRight size={12} /></button>
                      </div>
                      <button className="catalog-install" disabled title="Provisioning is inactive in this read-only build">
                        <Plus size={15} /> Install (inactive)
                      </button>
                    </article>
                  );
                })}
              </div>

              <div className="catalog-note">
                <Shield size={17} />
                <span>
                  <strong>Read-only catalog.</strong> Installing a service needs an authenticated provisioning API,
                  which this build does not include. Catalog entries are shown for review only.
                </span>
              </div>
            </>
          )}

          {section === 'Installed' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CONTAINER MANAGEMENT <span>·</span> READ-ONLY</div>
                  <h1>Installed services</h1>
                  <p>Published records for this node. Container controls are inactive.</p>
                </div>
                <button className="button-primary" onClick={() => setSection('Apps')}><Plus size={16} /> Add a service</button>
              </div>

              {loadingRecords && services.length === 0 ? (
                <div className="empty-state">Reading published services…</div>
              ) : services.length === 0 ? (
                <div className="empty-state">No NCC service records were found on the configured relays.</div>
              ) : (
                <div className="installed-list">
                  {services.map((service) => {
                    const meta = serviceMeta(service.id);
                    const status = statusCopy(service);
                    const href = safeHref(service.endpoint);
                    return (
                      <article className="installed-card" key={service.id}>
                        <div className="installed-main">
                          <IconBox icon={meta.icon} tint={meta.tint} />
                          <div className="service-name">
                            <div className="installed-title">
                              <strong>{meta.label}</strong>
                              <span className={`status-pill ${status.tone}`}><i />{status.label}</span>
                            </div>
                            <small>{service.pin ? `pin ${service.pin.slice(0, 16)}…` : 'No certificate pin published'}</small>
                          </div>
                          <button className="icon-quiet" disabled aria-label={`${meta.label} actions (inactive)`} title="Container controls are inactive in this read-only build">
                            <MoreHorizontal size={19} />
                          </button>
                        </div>
                        <div className="installed-details">
                          <div><span>PUBLIC ENDPOINT</span><strong>{service.endpoint ?? 'Not published'}</strong></div>
                          <div><span>HEALTH</span><strong className="health-muted">Not monitored in this build</strong></div>
                          <div><span>PUBLICATION</span><strong>{status.label} · {expiryLabel(service)}</strong></div>
                        </div>
                        <div className="installed-actions">
                          <button disabled title="Log streaming is inactive in this read-only build"><TerminalSquare size={14} /> Logs</button>
                          <button disabled title="Restart is inactive in this read-only build"><Activity size={14} /> Restart</button>
                          <button disabled title="Republishing is inactive in this read-only build"><Radio size={14} /> Republish</button>
                          {href ? (
                            <a className="external-action" href={href} target="_blank" rel="noreferrer">
                              <ExternalLink size={14} /> Open endpoint
                            </a>
                          ) : (
                            <button className="external-action" disabled title="No HTTPS endpoint is published">
                              <ExternalLink size={14} /> Open endpoint
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {section === 'Activity' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">AUDIT TRAIL <span>·</span> FROM RELAYS</div>
                  <h1>Activity on your node.</h1>
                  <p>Publication timestamps from the NCC records found on your relays.</p>
                </div>
                <button className="filter-button" disabled title="History filtering is inactive in this build">All records <ChevronDown size={14} /></button>
              </div>

              {groups.length === 0 ? (
                <div className="empty-state">No publication history was found on the configured relays.</div>
              ) : (
                <div className="activity-full">
                  {groups.map((group) => (
                    <div key={group.label}>
                      <div className="activity-date">{group.label.toUpperCase()}</div>
                      {group.items.map((item) => <ActivityRow key={`${item.kind}-${item.serviceId}-${item.createdAt}`} item={item} />)}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {section === 'Admins' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ACCESS CONTROL <span>·</span> NOSTR KEYS</div>
                  <h1>People who run this node.</h1>
                  <p>Admins sign in with their Nostr key. The sidecar stores the list, and every change is signed by you.</p>
                </div>
              </div>

              <div className="admin-callout">
                <div className="callout-shield"><ShieldCheck size={20} /></div>
                <div>
                  <strong>{apiAvailable ? 'Access follows the node admin list.' : 'Admin management is inactive on this node.'}</strong>
                  <p>
                    {apiAvailable
                      ? 'Each request is authorized by a NIP-98 signature from your signer; the sidecar verifies it against the active admins for this node.'
                      : 'This node does not serve /ncc-api yet. Deploy the current sidecar and Caddy images to manage keys from this panel.'}
                  </p>
                </div>
                <span>{apiAvailable ? 'NIP-98 SIGNED' : 'INACTIVE'}</span>
              </div>

              <section className="admin-section">
                <div className="section-heading">
                  <div>
                    <h2>Node administrators <span className="count-chip">{adminRows.length}</span></h2>
                    <p>{admins ? 'Keys the sidecar accepts for this node.' : 'Verified operator for this node.'}</p>
                  </div>
                  {adminsLoading && (
                    <span className="admin-loading" role="status"><span className="button-spinner dark" /> Reading the admin list…</span>
                  )}
                </div>

                <div className="admin-table">
                  <div className="admin-table-head"><span>ADMIN</span><span>ACCESS</span><span>ADDED</span><span /></div>
                  {adminRows.map((admin) => {
                    const owner = Boolean(operatorPubkey && admin.pubkey === operatorPubkey);
                    const removable = Boolean(!owner && admins && apiAvailable);
                    const confirm = confirmRemove === admin.pubkey;

                    return (
                      <div className="admin-table-row" key={admin.pubkey || admin.npub}>
                        <div className="admin-person">
                          <span className={`admin-avatar ${owner ? 'lime' : 'blue'}`}>{initials(admin.npub)}</span>
                          <span>
                            <strong>{owner ? 'Node operator' : 'Admin'}</strong>
                            <small>
                              {shortNpub(admin.npub)}
                              <button
                                aria-label={`Copy ${owner ? 'operator' : 'admin'} npub`}
                                onClick={() => copy(admin.npub, owner ? 'Operator npub' : 'Admin npub')}
                              >
                                <Copy size={12} />
                              </button>
                            </small>
                          </span>
                        </div>
                        <span className={`admin-state ${admin.status === 'pending' ? 'pending' : ''}`}>
                          <i />{owner ? 'Owner · verified' : admin.status === 'pending' ? 'Invited' : 'Admin'}
                        </span>
                        <span className="admin-added">{owner ? 'Operator key' : addedLabel(admin.createdAt)}</span>
                        {removable ? (
                          <button
                            className={`icon-quiet ${confirm ? 'danger' : ''}`}
                            type="button"
                            disabled={adminBusy}
                            aria-label={confirm ? 'Confirm removing this admin' : 'Remove this admin'}
                            title={confirm ? 'Click again to remove this admin' : 'Remove this admin'}
                            onClick={() => handleRemove(admin.pubkey)}
                          >
                            <Trash2 size={16} />
                          </button>
                        ) : (
                          <button
                            className="icon-quiet"
                            type="button"
                            disabled
                            aria-label="Admin actions unavailable"
                            title={owner ? 'The node operator key cannot be removed' : 'Load the admin list to manage keys'}
                          >
                            <MoreHorizontal size={18} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {adminsState === 'error' && (
                  <div className="invite-error" role="alert">
                    <CircleAlert size={14} />
                    <span>{adminsError}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setAdminsState('idle');
                        setAdminsError('');
                        setAdminsToken((value) => value + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </section>

              <section className="invite-card">
                <div className="invite-heading">
                  <span className="invite-icon"><Plus size={18} /></span>
                  <div>
                    <h2>Add an admin</h2>
                    <p>
                      {apiAvailable
                        ? 'Allow another Nostr key to open this panel and manage the node.'
                        : 'Adding another key needs the sidecar admin API, which this node does not serve yet.'}
                    </p>
                  </div>
                  {!apiAvailable && <span className="inactive-badge">INACTIVE</span>}
                </div>
                <form onSubmit={handleInvite}>
                  <label htmlFor="admin-npub">OPERATOR PUBLIC KEY</label>
                  <div className="invite-input-row">
                    <input
                      id="admin-npub"
                      value={inviteNpub}
                      onChange={(event) => { setInviteNpub(event.target.value); setInviteDone(''); setInviteError(''); }}
                      placeholder="npub1…"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canManageAdmins || adminBusy}
                    />
                    <button
                      className="button-primary"
                      type="submit"
                      disabled={!canManageAdmins || adminBusy || inviteNpub.trim().length === 0}
                    >
                      {adminBusy ? <span className="button-spinner" /> : <Plus size={15} />}
                      {adminBusy ? 'Adding…' : 'Add admin'}
                    </button>
                  </div>
                  {inviteError && (
                    <p className="invite-error" role="alert"><CircleAlert size={12} /> {inviteError}</p>
                  )}
                  {inviteDone && (
                    <p className="invite-success"><Check size={12} /> {inviteDone}</p>
                  )}
                  <small><LockKeyhole size={12} /> Public key only. Never enter or share a private key here.</small>
                </form>
              </section>

              <div className="admin-footnote">
                <CircleHelp size={15} />
                <span>
                  {apiAvailable
                    ? 'An admin key works only while it stays in the sidecar list. Removing a key takes effect immediately.'
                    : 'This panel reads the operator key from the node config. Admin management stays inactive until the node serves /ncc-api.'}
                </span>
              </div>
            </>
          )}

          {section === 'Settings' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">NODE CONFIGURATION <span>·</span> READ-ONLY</div>
                  <h1>Settings for this server.</h1>
                  <p>The identity and records this node publishes on Nostr.</p>
                </div>
              </div>

              <div className="settings-grid">
                <section className="settings-card">
                  <div className="settings-card-title">
                    <Globe2 size={17} />
                    <div><h2>Public identity</h2><p>How clients find this node on Nostr.</p></div>
                  </div>
                  <label>OPERATOR NPUB</label>
                  <div className="settings-readonly">
                    <span>{shortNpub(operatorNpub)}</span>
                    <button className="icon-quiet" onClick={() => copy(operatorNpub, 'Operator npub')} aria-label="Copy operator npub"><Copy size={14} /></button>
                  </div>
                  <label>PUBLIC ADDRESS</label>
                  <div className="settings-readonly">
                    <span>{publicHosts[0] ?? 'Not published'}</span>
                  </div>
                  {publicHosts.length > 1 && <small className="settings-hint">{publicHosts.length} endpoints published across services.</small>}
                  <button className="text-button" disabled title="Identity is managed by the NCC sidecar">
                    Managed by the sidecar <LockKeyhole size={12} />
                  </button>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <Radio size={17} />
                    <div><h2>Publication relays</h2><p>Where this browser looks for your NCC records.</p></div>
                  </div>
                  {(snapshot?.relays ?? (config?.relays ?? []).map((url) => ({ url, connected: false, anchorCount: 0, locatorCount: 0 }))).map((relay) => (
                    <div className="relay-setting" key={relay.url}>
                      <i className={`relay-dot ${relay.connected ? '' : 'off'}`} />
                      <span>
                        <strong>{new URL(relay.url).host}</strong>
                        <small>{relay.url}</small>
                      </span>
                      <span className={`relay-state ${relay.connected ? '' : 'off'}`}>
                        {snapshot ? (relay.connected ? `${relay.anchorCount + relay.locatorCount} records` : 'Unreachable') : 'Not checked'}
                      </span>
                    </div>
                  ))}
                  <button className="text-button" disabled title="Relay configuration is managed by the NCC sidecar">
                    Managed by the sidecar <LockKeyhole size={12} />
                  </button>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <Shield size={17} />
                    <div><h2>Admin access</h2><p>Operators sign in with Nostr keys only.</p></div>
                  </div>
                  <div className="settings-inline"><span>Operator keys</span><strong>{operatorPubkey ? '1 active' : 'None'}</strong></div>
                  <div className="settings-inline">
                    <span>Additional admin keys</span>
                    <strong>{admins ? `${Math.max(0, admins.length - 1)} active` : 'Managed under Admins'}</strong>
                  </div>
                  <button className="text-button" onClick={() => setSection('Admins')}>View operators <ArrowUpRight size={13} /></button>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <Layers3 size={17} />
                    <div><h2>Publication cadence</h2><p>Values reported by the latest locator.</p></div>
                  </div>
                  <div className="settings-inline"><span>Locator TTL</span><strong>{loadingRecords ? 'Reading…' : locatorTtl === null ? 'Not published' : durationLabel(locatorTtl)}</strong></div>
                  <div className="settings-inline"><span>Latest record</span><strong>{loadingRecords ? 'Reading…' : snapshot?.latestPublishedAt ? relativeTime(snapshot.latestPublishedAt) : '—'}</strong></div>
                  <div className="settings-inline"><span>Records found</span><strong>{loadingRecords ? 'Reading…' : services.length}</strong></div>
                </section>
              </div>
            </>
          )}
        </div>
      </main>

      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

      {selectedApp && (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedApp(null); }}
        >
          <section className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
            <div className="modal-top">
              <div className="eyebrow">SERVICE REVIEW <span>·</span> READ-ONLY</div>
              <button className="icon-quiet" onClick={() => setSelectedApp(null)} aria-label="Close"><X size={19} /></button>
            </div>
            <h2 id="install-title">Review {selectedApp.name}</h2>
            <p className="modal-intro">What this package would add to your server. Provisioning is inactive in this build.</p>
            <div className="modal-app">
              <IconBox icon={selectedApp.icon} tint={selectedApp.tint} />
              <div><strong>{selectedApp.name}</strong><small>{selectedApp.description}</small></div>
              <span className="inactive-badge">INACTIVE</span>
            </div>
            <div className="install-spec">
              <div><span>CONTAINER IMAGE</span><strong>{selectedApp.image}</strong></div>
              <div><span>PUBLIC ENDPOINT</span><strong>Assigned by the node during provisioning</strong></div>
              <div><span>DATA STORAGE</span><strong>/srv/ncc/apps/{selectedApp.name.toLowerCase().replaceAll(' ', '-')} · persistent</strong></div>
              <div><span>NETWORK ACCESS</span><strong>One public HTTPS port · backend loopback only</strong></div>
            </div>
            <div className="install-security">
              <LockKeyhole size={15} />
              <span>Secrets stay on this server. The service locator publishes only its public endpoint.</span>
            </div>
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setSelectedApp(null)}>Close</button>
              <button className="button-primary" disabled title="Provisioning is inactive in this read-only build">
                <Plus size={15} /> Install (inactive)
              </button>
            </div>
            <div className="install-step-hint">Read-only review · no containers are changed</div>
          </section>
        </div>
      )}

      {notice && <div className="toast-note"><Check size={15} />{notice}</div>}
    </div>
  );
}
