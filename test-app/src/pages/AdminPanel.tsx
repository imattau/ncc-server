import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNostrLogin } from '@nostrify/react/login';
import {
  Activity, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, CircleAlert,
  CircleHelp, Copy, Cpu, ExternalLink, Globe2, HardDrive, KeyRound, Layers3,
  LayoutGrid, LockKeyhole, LogOut, MemoryStick, Menu, Monitor, Moon, MoreHorizontal,
  Plus, Radio, RefreshCw, Rows3, Search,
  Server, Settings2, Shield, ShieldCheck, Smartphone, Sun, TerminalSquare, Trash2,
  Users, Waves, X,
  type LucideIcon,
} from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useTheme } from '@/hooks/useTheme';
import {
  generateNostrConnectParams,
  generateNostrConnectURI,
  useLoginActions,
  type NostrConnectStatus,
} from '@/hooks/useLoginActions';
import { QRCodeCanvas } from '@/components/ui/qrcode';
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
import { nccServiceAddress } from '@/lib/nccAddress';
import {
  PanelApiError,
  addPanelAdmin,
  cadenceProblem,
  listPanelAdmins,
  loadPanelCatalogue,
  loadPanelCatalogueIcon,
  loadPanelCatalogueService,
  loadPanelImages,
  loadPanelImageProgress,
  loadPanelMetrics,
  loadPanelRecords,
  loadPanelServiceLogs,
  loadPanelServices,
  loadPanelSettings,
  relayInputToUrl,
  removePanelAdmin,
  republishPanelService,
  resolvePanelApiBase,
  restartPanelService,
  savePanelCadence,
  savePanelIdentity,
  savePanelRelays,
  setPanelCatalogueTrust,
  updatePanelImages,
  type PanelAdmin,
  type PanelCadence,
  type PanelCatalogue,
  type PanelCatalogueEntry,
  type PanelCatalogueService,
  type PanelMetrics,
  type PanelNodeImage,
  type PanelNodeImages,
  type PanelImageProgress,
  type PanelNpanelStatus,
  type PanelServiceHealth,
  type PanelServiceLogs,
  type PanelServiceStatus,
  type PanelSettings,
} from '@/lib/nccPanelApi';
import type { PanelSigner } from '@/lib/nip98';
import './admin-panel.css';

type Section = 'Overview' | 'Apps' | 'Installed' | 'Activity' | 'Admins' | 'Settings';
type AdminAccess = 'idle' | 'checking' | 'admin' | 'denied' | 'unavailable';
type AdminListState = 'idle' | 'ready' | 'error';
type SettingsState = 'idle' | 'loading' | 'ready' | 'error';
type Tint = 'blue' | 'violet' | 'amber' | 'green';
type SignInMethod = 'extension' | 'bunker' | 'nostrconnect';

interface IdentityDraft {
  displayName: string;
  about: string;
  picture: string;
  nip05: string;
}

const EMPTY_IDENTITY: IdentityDraft = { displayName: '', about: '', picture: '', nip05: '' };
const EMPTY_CADENCE: PanelCadence = {
  refreshIntervalMinutes: 360,
  ncc02ExpiryDays: 14,
  ncc05TtlHours: 12,
};

type CadenceText = Record<keyof PanelCadence, string>;
type AppsView = 'grid' | 'list';

const THEME_OPTIONS: Array<{ value: 'light' | 'dark' | 'system'; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light / dark / system, persisted by AppProvider next to the relay list. */
function ThemeControl({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const Icon = THEME_OPTIONS.find((option) => option.value === theme)?.icon ?? Monitor;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className={`theme-control ${className ?? ''}`} ref={wrap}>
      <button
        className="icon-quiet theme-button"
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${theme}. Choose light, dark or system.`}
        title={`Theme: ${theme}`}
      >
        <Icon size={15} />
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="Theme">
          {THEME_OPTIONS.map(({ value, label, icon: OptionIcon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === value}
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
            >
              <OptionIcon size={14} /> {label}
              {theme === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AppsViewToggle({ value, onChange }: { value: AppsView; onChange: (value: AppsView) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="Apps layout">
      <button
        type="button"
        aria-pressed={value === 'grid'}
        aria-label="Grid view"
        title="Grid view"
        onClick={() => onChange('grid')}
      >
        <LayoutGrid size={14} />
      </button>
      <button
        type="button"
        aria-pressed={value === 'list'}
        aria-label="List view"
        title="List view"
        onClick={() => onChange('list')}
      >
        <Rows3 size={14} />
      </button>
    </div>
  );
}

function cadenceTextOf(cadence: PanelCadence): CadenceText {
  return {
    refreshIntervalMinutes: String(cadence.refreshIntervalMinutes),
    ncc02ExpiryDays: String(cadence.ncc02ExpiryDays),
    ncc05TtlHours: String(cadence.ncc05TtlHours),
  };
}

function cadenceFromText(text: CadenceText): PanelCadence {
  return {
    refreshIntervalMinutes: Number(text.refreshIntervalMinutes),
    ncc02ExpiryDays: Number(text.ncc02ExpiryDays),
    ncc05TtlHours: Number(text.ncc05TtlHours),
  };
}

/** True when a NIP-07 provider is actually injected into this page. */
function hasNip07(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { nostr?: unknown }).nostr);
}

function isMobileBrowser(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

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
  admin: { label: 'Admin Panel', description: 'Manage this node', route: 'admin', tint: 'green', icon: Shield, order: 5 },
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

function npanelProblem(status?: PanelNpanelStatus | null): string {
  const reason = status?.error?.trim();
  return `Npanel was not updated${reason ? `: ${reason}` : ''}.`;
}

function durationLabel(seconds: number): string {
  const value = Math.abs(Math.round(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
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

function healthCopy(
  status: PanelServiceStatus | undefined,
  loading: boolean,
): { label: string; tone: string; detail: string } {
  if (!status) {
    return {
      label: loading ? 'Checking…' : 'Not monitored',
      tone: 'health-muted',
      detail: loading
        ? 'Probing the service…'
        : 'Service health is not available from this node. Deploy the current sidecar image.',
    };
  }

  const detail: string[] = [];
  if (status.probe.error) detail.push(status.probe.error);
  if (status.container) {
    detail.push(`${status.container.names.join(', ')}: ${status.container.state}`);
    if (status.container.health) detail.push(status.container.health);
  }
  const failedRelays = status.publication.relays.filter((relay) => !relay.success);
  if (failedRelays.length) detail.push(`${failedRelays.length} relay(s) failing`);

  switch (status.health) {
    case 'healthy':
      return {
        label: status.probe.latencyMs !== null ? `Healthy · ${status.probe.latencyMs} ms` : 'Healthy',
        tone: 'health-good',
        detail: detail.join(' · '),
      };
    case 'degraded':
      return { label: 'Degraded', tone: 'health-warn', detail: detail.join(' · ') };
    case 'unreachable':
      return { label: 'Unreachable', tone: 'health-bad', detail: detail.join(' · ') };
    default:
      return { label: 'Unknown', tone: 'health-muted', detail: detail.join(' · ') };
  }
}

function logTimestamp(value: string | null): string {
  if (!value) return '—';
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const catalogueIconCache = new Map<string, string>();
const catalogueIconFailures = new Set<string>();
// npackd answers a refresh from its cached listing while relays are queried in
// the background, so the panel polls at this cadence for the finished result.
const CATALOGUE_REFRESH_POLL_MS = 3000;
const CATALOGUE_REFRESH_POLLS = 40;

/** Store icon, delivered through the node so the page signs each fetch. */
function ReleaseIcon({
  base,
  signer,
  release,
}: {
  base: string;
  signer: PanelSigner;
  release: PanelCatalogueEntry;
}) {
  const [url, setUrl] = useState<string | null>(
    () => catalogueIconCache.get(release.releaseEventId) ?? null,
  );

  useEffect(() => {
    if (url || !release.icon || catalogueIconFailures.has(release.releaseEventId)) return undefined;

    let cancelled = false;
    loadPanelCatalogueIcon(base, signer, release.releaseEventId)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        catalogueIconCache.set(release.releaseEventId, objectUrl);
        if (!cancelled) setUrl(objectUrl);
      })
      .catch(() => {
        // The package still lists fine without an icon.
        catalogueIconFailures.add(release.releaseEventId);
      });

    return () => { cancelled = true; };
  }, [base, signer, release, url]);

  if (url) {
    return <img className="catalog-icon" src={url} alt="" loading="lazy" />;
  }
  return <IconBox icon={Layers3} tint="green" />;
}

function publisherLabel(entry: PanelCatalogueEntry): string {
  if (entry.official) return 'Official publisher';
  if (entry.trusted) return 'Trusted publisher';
  return 'Unknown publisher';
}

function shortPublisher(entry: PanelCatalogueEntry): string {
  const value = entry.npub ?? entry.publisher;
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function byteSize(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function catalogueAge(catalogue: PanelCatalogue | null): string {
  const seconds = catalogue?.status?.ageSeconds;
  if (seconds === null || seconds === undefined) return 'not refreshed yet';
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function installCommand(entry: PanelCatalogueEntry): string {
  const publisher = entry.npub ?? entry.publisher;
  return `sudo make service-install REF=${publisher}/${entry.name}@${entry.version}`;
}

function shortImageId(value: string | null): string {
  if (!value) return 'unknown';
  return (value.startsWith('sha256:') ? value.slice(7) : value).slice(0, 12);
}

function imageBuiltLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function imageUpdateCopy(image: PanelNodeImage): { text: string; tone: 'good' | 'warn' | 'error' | 'muted' } {
  const update = image.update;
  if (!update) {
    if (!image.updatable) {
      return { text: 'Pinned by digest; nothing to pull', tone: 'muted' };
    }
    if (image.updateAvailable === true) {
      return { text: 'A newer image is available on the registry', tone: 'warn' };
    }
    if (image.updateAvailable === false) {
      return { text: 'Up to date', tone: 'good' };
    }
    return {
      text: image.checkError
        ? `Could not compare with the registry: ${image.checkError}`
        : 'Update availability unknown; check again',
      tone: 'muted',
    };
  }

  switch (update.state) {
    case 'pulling':
      return { text: 'Pulling the image…', tone: 'warn' };
    case 'queued':
      return { text: 'Waiting to update…', tone: 'warn' };
    case 'recreating':
      return { text: 'Recreating the container…', tone: 'warn' };
    case 'recreated':
      return { text: `Updated; now running ${shortImageId(update.imageId)}`, tone: 'good' };
    case 'current':
      return { text: 'Already up to date', tone: 'good' };
    case 'pinned':
      return { text: 'Pinned by digest; nothing to pull', tone: 'muted' };
    case 'failed':
      return { text: update.error ?? 'The update failed', tone: 'error' };
    default:
      return { text: 'Update state unknown', tone: 'muted' };
  }
}

function imageCheckedLabel(value: string | null): string {
  if (!value) return '';
  const checked = new Date(value);
  if (Number.isNaN(checked.getTime())) return '';
  return checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Apply the progress endpoint's per-service states to the image cards. */
function mergeImageProgress(images: PanelNodeImage[], progress: PanelImageProgress): PanelNodeImage[] {
  const byService = new Map(progress.services.map((entry) => [entry.service, entry]));
  return images.map((image) => {
    const entry = byService.get(image.service);
    if (!entry) return image;
    return {
      ...image,
      updateAvailable: false,
      update: {
        state: entry.state,
        changed: entry.changed,
        imageId: entry.imageId,
        error: entry.error,
      },
    };
  });
}

function safeLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
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
  verificationError: string;
  localKeyOnly: boolean;
  busy: SignInMethod | null;
  error: string;
  bunkerUri: string;
  connectUri: string;
  connectStatus: NostrConnectStatus | null;
  nip07Available: boolean;
  onBunkerUri: (value: string) => void;
  onExtension: () => void;
  onBunker: () => void;
  onNostrConnect: () => void;
  onCancelConnect: () => void;
  onRetryVerify: () => void;
  onSignOut: () => void;
  onCopy: (value: string, label: string) => void;
}

function OperatorGate({
  config, operatorNpub, signerNpub, access, verificationError, localKeyOnly, busy, error,
  bunkerUri, connectUri, connectStatus, nip07Available, onBunkerUri, onExtension, onBunker,
  onNostrConnect, onCancelConnect, onRetryVerify, onSignOut, onCopy,
}: OperatorGateProps) {
  const otherSigner = Boolean(signerNpub && signerNpub !== operatorNpub);
  const mobile = isMobileBrowser();
  const connectLabel = connectStatus === 'getting-public-key'
    ? 'Signer connected. Reading its public key…'
    : 'Waiting for your signer to approve this client…';

  return (
    <div className="ncc-panel gate-shell">
      <main className="gate-main">
        <section className="gate-card" aria-labelledby="gate-title">
          <div className="gate-theme"><ThemeControl /></div>
          <div className="gate-brand">
            <span className="panel-brand-mark"><Globe2 size={21} /></span>
            <span>NCC <i>/</i> SERVER</span>
            <span className="prototype-tag"><i /> SIGN-IN REQUIRED</span>
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
                        {verificationError && <small className="gate-detail">{verificationError}</small>}
                      </span>
                    </div>
                  )}
                  <div className="gate-identity">
                    <span>YOUR SIGNER</span>
                    <strong>{shortNpub(signerNpub)}</strong>
                  </div>
                  <div className="gate-actions">
                    {access !== 'checking' && (
                      <button className="button-secondary" type="button" onClick={onRetryVerify}>
                        <RefreshCw size={14} /> Try again
                      </button>
                    )}
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
                  {nip07Available ? (
                    <button className="button-primary gate-extension" type="button" onClick={onExtension} disabled={busy !== null}>
                      <KeyRound size={16} />
                      {busy === 'extension' ? 'Waiting for NIP-07 extension…' : 'Sign in with NIP-07 extension'}
                    </button>
                  ) : (
                    <div className="gate-note warning" role="alert">
                      <CircleAlert size={14} />
                      <span>
                        {mobile
                          ? 'Mobile browsers do not load NIP-07 extensions. Sign in with your signer app below.'
                          : 'No NIP-07 extension was detected in this browser. Install one, or use a remote signer below.'}
                      </span>
                    </div>
                  )}

                  <div className="gate-divider"><span>or a NIP-46 remote signer</span></div>

                  {connectUri ? (
                    <div className="gate-connect">
                      <div className="gate-qr" aria-label="NIP-46 connect QR code">
                        <QRCodeCanvas value={connectUri} size={148} />
                      </div>
                      <div className="gate-connect-copy">
                        <strong>{connectLabel}</strong>
                        <small>Scan this with a signer app, or open the link on this device and approve.</small>
                        <div className="gate-actions">
                          <a className="button-primary" href={connectUri}>
                            <Smartphone size={14} /> Open signer app
                          </a>
                          <button className="button-secondary" type="button" onClick={() => onCopy(connectUri, 'Connect URI')}>
                            <Copy size={14} /> Copy URI
                          </button>
                          <button className="button-secondary" type="button" onClick={onCancelConnect}>
                            <X size={14} /> Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button className="button-secondary gate-extension" type="button" onClick={onNostrConnect} disabled={busy !== null}>
                      <Smartphone size={16} />
                      {busy === 'nostrconnect' ? 'Starting signer connection…' : 'Open signer app (NIP-46)'}
                    </button>
                  )}

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
                    Extensions usually load only on desktop; on a phone use your signer app.
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
  const [appsView, setAppsView] = useLocalStorage<AppsView>('ncc:panel-apps-layout', 'grid');
  const [notice, setNotice] = useState('');
  const [appQuery, setAppQuery] = useState('');
  const [appCategory, setAppCategory] = useState('all');
  const [catalogue, setCatalogue] = useState<PanelCatalogue | null>(null);
  const [catalogueState, setCatalogueState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [catalogueError, setCatalogueError] = useState('');
  const [catalogueWarning, setCatalogueWarning] = useState('');
  const [catalogueToken, setCatalogueToken] = useState(0);
  const catalogueRefresh = useRef(false);
  const [nodeImages, setNodeImages] = useState<PanelNodeImages | null>(null);
  const [nodeImagesState, setNodeImagesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [nodeImagesError, setNodeImagesError] = useState('');
  const [imagesToken, setImagesToken] = useState(0);
  const imagesForce = useRef(false);
  const [imageBusy, setImageBusy] = useState<string | null>(null);
  const [imageStarting, setImageStarting] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageDone, setImageDone] = useState('');
  const [imageProgress, setImageProgress] = useState<PanelImageProgress | null>(null);
  const [progressToken, setProgressToken] = useState<string | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<string | null>(null);
  const [confirmUpdateAll, setConfirmUpdateAll] = useState(false);
  const [selectedRelease, setSelectedRelease] = useState<PanelCatalogueEntry | null>(null);
  const [releaseDetails, setReleaseDetails] = useState<PanelCatalogueService | null>(null);
  const [releaseState, setReleaseState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [releaseError, setReleaseError] = useState('');
  const [releaseToken, setReleaseToken] = useState(0);
  const [trustBusy, setTrustBusy] = useState(false);

  const [signInBusy, setSignInBusy] = useState<SignInMethod | null>(null);
  const [signInError, setSignInError] = useState('');
  const [bunkerUri, setBunkerUri] = useState('');
  const [connectUri, setConnectUri] = useState('');
  const [connectStatus, setConnectStatus] = useState<NostrConnectStatus | null>(null);
  const connectAbort = useRef<AbortController | null>(null);
  const [nip07Available, setNip07Available] = useState(hasNip07);

  const [verified, setVerified] = useState<{ pubkey: string; access: 'admin' | 'denied' | 'unavailable' } | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const [verifyToken, setVerifyToken] = useState(0);
  const [admins, setAdmins] = useState<PanelAdmin[] | null>(null);
  const [adminsState, setAdminsState] = useState<AdminListState>('idle');
  const [adminsError, setAdminsError] = useState('');
  const [adminsToken, setAdminsToken] = useState(0);
  const [adminBusy, setAdminBusy] = useState(false);
  const [inviteNpub, setInviteNpub] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteDone, setInviteDone] = useState('');
  const [inviteWarning, setInviteWarning] = useState('');
  const [npanelStatus, setNpanelStatus] = useState<PanelNpanelStatus | null>(null);
  const [grantingPubkey, setGrantingPubkey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [settings, setSettings] = useState<PanelSettings | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsState>('idle');
  const [settingsError, setSettingsError] = useState('');
  const [settingsDone, setSettingsDone] = useState('');
  const [settingsBusy, setSettingsBusy] = useState<'relays' | 'identity' | 'cadence' | null>(null);
  const [settingsToken, setSettingsToken] = useState(0);
  const [relayDraft, setRelayDraft] = useState<string[]>([]);
  const [newRelay, setNewRelay] = useState('');
  const [relayError, setRelayError] = useState('');
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft>(EMPTY_IDENTITY);
  const [identityError, setIdentityError] = useState('');
  const [cadenceText, setCadenceText] = useState(() => cadenceTextOf(EMPTY_CADENCE));
  const [cadenceError, setCadenceError] = useState('');

  const [serviceHealth, setServiceHealth] = useState<PanelServiceHealth | null>(null);
  const [healthState, setHealthState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [healthError, setHealthError] = useState('');
  const [healthToken, setHealthToken] = useState(0);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [controlError, setControlError] = useState('');
  const [confirmRestart, setConfirmRestart] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<PanelService | null>(null);
  const [serviceLogs, setServiceLogs] = useState<PanelServiceLogs | null>(null);
  const [logsState, setLogsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [logsError, setLogsError] = useState('');
  const [logsToken, setLogsToken] = useState(0);
  const [logsTab, setLogsTab] = useState<'container' | 'node'>('container');
  const [metrics, setMetrics] = useState<PanelMetrics | null>(null);
  const [metricsState, setMetricsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('loading');
  const [metricsError, setMetricsError] = useState('');
  const [metricsRouteMissing, setMetricsRouteMissing] = useState(false);
  const [metricsToken, setMetricsToken] = useState(0);

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
  // Once the sidecar settings are loaded they name the relays this node
  // actually publishes to, which is more accurate than the static config.
  const readRelays = useMemo(
    () => (settings && settings.relays.length ? settings.relays : (config?.relays ?? [])),
    [settings, config],
  );
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

  // Some extensions inject window.nostr after the first paint. Recheck once
  // so a desktop user does not lose the NIP-07 option on a slow load.
  useEffect(() => {
    if (nip07Available) return;
    const timer = window.setTimeout(() => setNip07Available(hasNip07()), 1000);
    return () => window.clearTimeout(timer);
  }, [nip07Available]);

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
        setNpanelStatus(result.npanel ?? null);
        setAdminsState('ready');
        setVerifyError('');
        setVerified({ pubkey: signerPubkey, access: 'admin' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setVerifyError(error instanceof Error ? error.message : 'The node admin API did not answer');
        setVerified({
          pubkey: signerPubkey,
          access: error instanceof PanelApiError && error.status === 403 ? 'denied' : 'unavailable',
        });
      });

    return () => controller.abort();
  }, [supportedSigner, signerPubkey, isOperator, apiBase, user, verifyToken]);

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
        setNpanelStatus(result.npanel ?? null);
        setAdminsState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAdminsState('error');
        setAdminsError(error instanceof Error ? error.message : 'Could not read the admin list');
      });

    return () => controller.abort();
  }, [section, authorized, admins, apiBase, user, adminsToken]);

  // Node settings are loaded when the Settings section opens. Reading them
  // costs one NIP-98 signature, so they are not fetched with the overview.
  useEffect(() => {
    if (section !== 'Settings' || !authorized || settings !== null) return;
    if (!apiBase || !user) return;

    const controller = new AbortController();

    loadPanelSettings(apiBase, user.signer, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setSettings(loaded);
        setRelayDraft(loaded.relays);
        setIdentityDraft({
          displayName: loaded.identity.displayName,
          about: loaded.identity.about,
          picture: loaded.identity.picture,
          nip05: loaded.identity.nip05,
        });
        setCadenceText(cadenceTextOf(loaded.cadence));
        setSettingsState('ready');
        setSettingsError('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettingsState('error');
        setSettingsError(error instanceof Error ? error.message : 'Could not read the node settings');
      });

    return () => controller.abort();
  }, [section, authorized, settings, apiBase, user, settingsToken]);

  // Health is a real server-side probe, so it is loaded when the Installed
  // section opens (and when the operator checks again), not polled from the
  // page. Each load costs one NIP-98 signature.
  useEffect(() => {
    if (section !== 'Installed' || !authorized || !apiBase || !user) return;

    const controller = new AbortController();

    loadPanelServices(apiBase, user.signer, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setServiceHealth(loaded);
        setHealthState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealthState('error');
        setHealthError(error instanceof Error ? error.message : 'Could not read service health');
      });

    return () => controller.abort();
  }, [section, authorized, apiBase, user, healthToken]);

  // Logs are fetched only while the modal is open. The sidecar returns node
  // events and recent container output in one authorized request.
  useEffect(() => {
    if (!logsFor || !authorized || !apiBase || !user) return;

    const controller = new AbortController();

    loadPanelServiceLogs(apiBase, user.signer, logsFor.id, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setServiceLogs(loaded);
        setLogsState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLogsState('error');
        setLogsError(error instanceof Error ? error.message : 'Could not read the service logs');
      });

    return () => controller.abort();
  }, [logsFor, logsToken, authorized, apiBase, user]);

  // The catalogue is read from the node's npack service, not from the
  // browser: an ncc:// page cannot open relay WebSockets, and a browser
  // should not be the thing that verifies package metadata.
  useEffect(() => {
    if (section !== 'Apps' || !authorized || !apiBase || !user) return;

    const controller = new AbortController();
    const refresh = catalogueRefresh.current;
    catalogueRefresh.current = false;
    let timer: number | undefined;
    let polls = 0;

    const load = (askForRefresh: boolean, canFallBack = askForRefresh) => {
      loadPanelCatalogue(apiBase, user.signer, askForRefresh, controller.signal)
        .then((loaded) => {
          if (controller.signal.aborted) return;
          setCatalogue(loaded);
          if (askForRefresh) setCatalogueWarning('');
          if (loaded.refreshing && polls < CATALOGUE_REFRESH_POLLS) {
            polls += 1;
            setCatalogueState('loading');
            timer = window.setTimeout(() => load(false), CATALOGUE_REFRESH_POLL_MS);
            return;
          }
          // A bounded wait keeps the button honest: after this the panel shows
          // the last listing and explains that the node is still refreshing.
          setCatalogueState('ready');
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // A sidecar from before the async-refresh change blocks the whole
          // relay query in the refresh request. Ask again without the refresh
          // flag so the cached listing can still open the page.
          if (canFallBack && error instanceof PanelApiError && error.status === 0) {
            setCatalogueWarning(
              'The node did not answer the refresh request. Showing the last catalogue it served. '
              + 'If the panel was just updated, recreate the sidecar container with the matching image.',
            );
            load(false, false);
            return;
          }
          const message = error instanceof Error ? error.message : 'Could not read the App catalogue';
          setCatalogueState('error');
          setCatalogueError(
            error instanceof PanelApiError && error.status === 0 && message.includes('took too long')
              ? `${message}. If the panel was just updated, the sidecar container may still be running `
                + 'the previous image — recreate it with the matching SIDECAR_IMAGE.'
              : message,
          );
        });
    };

    load(refresh);

    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [section, authorized, apiBase, user, catalogueToken]);

  // Node images come from the node-agent, also only while Apps is open. The
  // list is loaded once per visit (and on Check images), never polled: every
  // read asks the signer for a fresh NIP-98 event.
  useEffect(() => {
    if (section !== 'Apps' || !authorized || !apiBase || !user) return;

    const controller = new AbortController();
    const force = imagesForce.current;
    imagesForce.current = false;

    loadPanelImages(apiBase, user.signer, controller.signal, force)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setNodeImages(loaded);
        setNodeImagesError('');
        setNodeImagesState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setNodeImagesState('error');
        setNodeImagesError(error instanceof Error ? error.message : 'Could not read the node images');
      });

    return () => controller.abort();
  }, [section, authorized, apiBase, user, imagesToken]);

  // Follow a started image update through the token returned by the start
  // call. Polling this route does not need a new NIP-98 event, so a NIP-46
  // signer is not prompted every couple of seconds.
  useEffect(() => {
    if (!progressToken || section !== 'Apps') return;

    const controller = new AbortController();
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;

    const poll = async () => {
      try {
        const next = await loadPanelImageProgress(progressToken, controller.signal);
        if (stopped) return;
        failures = 0;
        setImageProgress(next);
        setNodeImages((current) => current ? {
          ...current,
          updating: next.inProgress,
          images: mergeImageProgress(current.images, next),
        } : current);
        if (next.inProgress) {
          timer = window.setTimeout(poll, 1500);
        } else {
          setProgressToken(null);
        }
      } catch (error) {
        if (stopped) return;
        failures += 1;
        const expired = error instanceof PanelApiError && error.status === 401;
        if (expired || failures >= 5) {
          setImageProgress((current) => current ? {
            ...current,
            inProgress: false,
            error: error instanceof Error ? error.message : 'Update progress is unavailable',
          } : current);
          setNodeImages((current) => current ? { ...current, updating: false } : current);
          setProgressToken(null);
          return;
        }
        timer = window.setTimeout(poll, 2500);
      }
    };

    poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [progressToken, section]);

  // Host metrics are not section-bound: the sidebar Storage card is on every
  // page. They load once per session and on Refresh, not on a timer, because
  // every read asks the signer for a NIP-98 event and polling would prompt a
  // NIP-46 signer over and over.
  useEffect(() => {
    if (!authorized || !apiBase || !user) return;

    const controller = new AbortController();

    loadPanelMetrics(apiBase, user.signer, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setMetrics(loaded);
        setMetricsError(loaded.error ?? '');
        setMetricsRouteMissing(false);
        setMetricsState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A node running the new panel against a sidecar image without the
        // route is a deployment mismatch, not an agent failure.
        setMetricsRouteMissing(error instanceof PanelApiError && error.status === 404);
        setMetricsError(error instanceof Error ? error.message : 'Could not read host metrics');
        setMetricsState('error');
      });

    return () => controller.abort();
  }, [authorized, apiBase, user, metricsToken]);

  // Descriptor fields and the verified artifact are loaded only when the
  // details dialog opens; listing the catalogue stays one request.
  useEffect(() => {
    if (!selectedRelease || !authorized || !apiBase || !user) return;

    const controller = new AbortController();

    loadPanelCatalogueService(apiBase, user.signer, selectedRelease.releaseEventId, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setReleaseDetails(loaded);
        setReleaseState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setReleaseState('error');
        setReleaseError(error instanceof Error ? error.message : 'Could not load the service package');
      });

    return () => controller.abort();
  }, [selectedRelease, releaseToken, authorized, apiBase, user]);

  useEffect(() => {
    if (!selectedRelease) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelectedRelease(null);
      setReleaseDetails(null);
      setReleaseState('idle');
      setReleaseError('');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedRelease]);

  useEffect(() => {
    if (!logsFor) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLogsFor(null);
      setServiceLogs(null);
      setLogsState('idle');
      setLogsError('');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logsFor]);

  useEffect(() => {
    if (!config || !operatorPubkey || !authorized) return;

    const controller = new AbortController();

    // The sidecar queries relays because an ncc:// page cannot open a
    // WebSocket to them; every relay would look unreachable in NCC Browser.
    // An older sidecar without /records falls back to querying from here.
    const request = apiBase && user
      ? loadPanelRecords(apiBase, user.signer, controller.signal).catch((error: unknown) => {
          const notServed = error instanceof PanelApiError && (error.status === 404 || error.status === 0);
          if (!notServed) throw error;
          return loadPanelSnapshot(operatorPubkey, readRelays, controller.signal).catch(() => {
            throw error;
          });
        })
      : loadPanelSnapshot(operatorPubkey, readRelays, controller.signal);

    request
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
  }, [config, operatorPubkey, authorized, refreshToken, readRelays, apiBase, user]);

  const handleExtension = async () => {
    setSignInError('');
    if (!hasNip07()) {
      setSignInError(
        isMobileBrowser()
          ? 'Mobile browsers do not load NIP-07 extensions. Use the signer app option below.'
          : 'No NIP-07 extension was detected. Install a signer extension or use the remote signer option below.',
      );
      return;
    }
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

  const cancelNostrConnect = () => {
    connectAbort.current?.abort();
    connectAbort.current = null;
    setConnectUri('');
    setConnectStatus(null);
    setSignInBusy(null);
  };

  // Client-initiated NIP-46: the browser creates the session and the signer
  // app approves it. This is the path that works on phones, where browsers
  // cannot load NIP-07 extensions.
  const handleNostrConnect = () => {
    setSignInError('');
    cancelNostrConnect();

    let params;
    try {
      params = generateNostrConnectParams(login.getRelayUrls());
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : 'Could not start a signer connection.');
      return;
    }

    const uri = generateNostrConnectURI(params, { name: 'NCC Server Admin' });
    const controller = new AbortController();
    connectAbort.current = controller;
    setConnectUri(uri);
    setConnectStatus('awaiting-connect');
    setSignInBusy('nostrconnect');

    login.nostrconnect(params, controller.signal, (status) => {
      if (!controller.signal.aborted) setConnectStatus(status);
    })
      .then(() => {
        if (controller.signal.aborted) return;
        setConnectUri('');
        setConnectStatus(null);
        setSignInBusy(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setConnectUri('');
        setConnectStatus(null);
        setSignInBusy(null);
        setSignInError(
          error instanceof Error && error.message
            ? `NIP-46 sign-in failed: ${error.message}`
            : 'The signer app did not approve this client.',
        );
      });
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
    cancelNostrConnect();
    await login.logout();
    setSnapshot(null);
    setRecordsError('');
    setLoadedAt(null);
    setSection('Overview');
    setVerified(null);
    setVerifyError('');
    setAdmins(null);
    setAdminsState('idle');
    setAdminsError('');
    setInviteNpub('');
    setInviteError('');
    setInviteDone('');
    setConfirmRemove(null);
    setSettings(null);
    setSettingsState('idle');
    setSettingsError('');
    setSettingsDone('');
    setRelayDraft([]);
    setNewRelay('');
    setRelayError('');
    setIdentityDraft(EMPTY_IDENTITY);
    setIdentityError('');
    setCadenceText(cadenceTextOf(EMPTY_CADENCE));
    setCadenceError('');
    setServiceHealth(null);
    setHealthState('idle');
    setHealthError('');
    setControlBusy(null);
    setControlError('');
    setConfirmRestart(null);
    setLogsFor(null);
    setServiceLogs(null);
    setLogsState('idle');
    setLogsError('');
  };

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    setInviteError('');
    setInviteDone('');
    setInviteWarning('');

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
      setNpanelStatus(result.npanel ?? null);
      setAdminsState('ready');
      setInviteNpub('');
      setConfirmRemove(null);

      const added = result.added
        ? `Key added${result.inviteSent ? ' and the sidecar sent an invite' : ''}.`
        : 'That key is already an admin.';
      const npanel = result.npanel;
      if (npanel?.configured && npanel.synced === false) {
        setInviteDone(added);
        setInviteWarning(npanelProblem(npanel));
        notify('Admin saved; npanel access was not granted');
      } else {
        const message = npanel?.synced
          ? `${added} Npanel admin access granted.`
          : added;
        setInviteDone(message);
        notify(message);
      }
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not add the key');
    } finally {
      setAdminBusy(false);
    }
  };

  // Re-posting an existing admin is how a npanel grant is retried; the
  // sidecar skips the duplicate invite and only runs the sync.
  const handleGrantNpanel = async (admin: PanelAdmin) => {
    if (!apiBase || !user) return;

    setAdminBusy(true);
    setGrantingPubkey(admin.pubkey);
    setInviteError('');
    setInviteDone('');
    setInviteWarning('');
    try {
      const result = await addPanelAdmin(apiBase, user.signer, admin.npub);
      setAdmins(result.admins);
      setNpanelStatus(result.npanel ?? null);
      setAdminsState('ready');
      if (result.npanel?.synced) {
        setInviteDone('Npanel admin access granted.');
        notify('Npanel admin access granted');
      } else {
        setInviteWarning(npanelProblem(result.npanel));
      }
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not grant npanel access');
    } finally {
      setAdminBusy(false);
      setGrantingPubkey(null);
    }
  };

  const handleRemove = async (pubkey: string) => {
    if (!apiBase || !user) return;

    if (confirmRemove !== pubkey) {
      setConfirmRemove(pubkey);
      setInviteError('');
      setInviteDone('');
      setInviteWarning('');
      notify('Click remove again to confirm');
      return;
    }

    setAdminBusy(true);
    setInviteError('');
    setInviteDone('');
    setInviteWarning('');
    try {
      const result = await removePanelAdmin(apiBase, user.signer, pubkey);
      setAdmins(result.admins);
      setNpanelStatus(result.npanel ?? null);
      setAdminsState('ready');
      const npanel = result.npanel;
      if (npanel?.configured && npanel.synced === false) {
        setInviteDone('Admin key removed.');
        setInviteWarning(npanelProblem(npanel));
        notify('Admin removed; npanel access was not changed');
      } else {
        const message = npanel?.synced && npanel.role === 'staff'
          ? 'Admin key removed. Npanel role set to staff.'
          : 'Admin key removed.';
        setInviteDone(message);
        notify('Admin key removed');
      }
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not remove the key');
    } finally {
      setAdminBusy(false);
      setConfirmRemove(null);
    }
  };

  const handleAddRelay = () => {
    setRelayError('');
    setSettingsDone('');
    const value = newRelay.trim();
    if (!value) return;

    const relay = relayInputToUrl(value);
    if (!relay) {
      setRelayError('Enter a relay URL such as wss://relay.example/');
      return;
    }
    if (relayDraft.includes(relay)) {
      setRelayError('That relay is already on the list.');
      return;
    }

    setRelayDraft([...relayDraft, relay]);
    setNewRelay('');
  };

  const handleRemoveRelay = (url: string) => {
    setRelayError('');
    setSettingsDone('');
    setRelayDraft(relayDraft.filter((relay) => relay !== url));
  };

  const handleSaveRelays = async () => {
    setRelayError('');
    setSettingsDone('');

    const relays: string[] = [];
    for (const value of relayDraft) {
      const relay = relayInputToUrl(value);
      if (!relay) {
        setRelayError(`"${value}" is not a valid relay URL.`);
        return;
      }
      if (!relays.includes(relay)) relays.push(relay);
    }
    if (relays.length === 0) {
      setRelayError('Keep at least one publication relay, or the node cannot publish records.');
      return;
    }
    if (!apiBase || !user) {
      setRelayError('The node admin API is not available.');
      return;
    }

    setSettingsBusy('relays');
    try {
      const next = await savePanelRelays(apiBase, user.signer, relays);
      setSettings(next);
      setRelayDraft(next.relays);
      setNewRelay('');
      setSettingsState('ready');
      setSettingsDone('Publication relays saved. The node republishes to them within a minute.');
      notify('Publication relays saved');
    } catch (error) {
      setRelayError(error instanceof Error ? error.message : 'Could not save the relays');
    } finally {
      setSettingsBusy(null);
    }
  };

  const handleSaveIdentity = async () => {
    setIdentityError('');
    setSettingsDone('');

    if (!identityDraft.displayName.trim()) {
      setIdentityError('A display name is required.');
      return;
    }
    if (!apiBase || !user) {
      setIdentityError('The node admin API is not available.');
      return;
    }

    setSettingsBusy('identity');
    try {
      const next = await savePanelIdentity(apiBase, user.signer, {
        displayName: identityDraft.displayName,
        about: identityDraft.about,
        picture: identityDraft.picture,
        nip05: identityDraft.nip05,
      });
      setSettings(next);
      setIdentityDraft({
        displayName: next.identity.displayName,
        about: next.identity.about,
        picture: next.identity.picture,
        nip05: next.identity.nip05,
      });
      setSettingsState('ready');
      setSettingsDone('Public identity saved. The node publishes the new profile within a minute.');
      notify('Public identity saved');
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : 'Could not save the identity');
    } finally {
      setSettingsBusy(null);
    }
  };

  const handleSaveCadence = async () => {
    setCadenceError('');
    setSettingsDone('');

    const cadence = cadenceFromText(cadenceText);
    const problem = cadenceProblem(cadence);
    if (problem) {
      setCadenceError(problem);
      return;
    }
    if (!apiBase || !user) {
      setCadenceError('The node admin API is not available.');
      return;
    }

    setSettingsBusy('cadence');
    try {
      const next = await savePanelCadence(apiBase, user.signer, cadence);
      setSettings(next);
      setCadenceText(cadenceTextOf(next.cadence));
      setSettingsState('ready');
      setSettingsDone('Publication cadence saved. The node republishes existing records within a minute.');
      notify('Publication cadence saved');
    } catch (error) {
      setCadenceError(error instanceof Error ? error.message : 'Could not save the cadence');
    } finally {
      setSettingsBusy(null);
    }
  };

  const handleRetryVerify = () => {
    setVerified(null);
    setVerifyError('');
    setVerifyToken((value) => value + 1);
  };

  if (!authorized || !operatorNpub) {
    return (
      <OperatorGate
        config={config}
        operatorNpub={operatorNpub ?? ''}
        signerNpub={signerNpub}
        access={access}
        verificationError={verifyError}
        localKeyOnly={localKeyOnly}
        busy={signInBusy}
        error={signInError}
        bunkerUri={bunkerUri}
        connectUri={connectUri}
        connectStatus={connectStatus}
        nip07Available={nip07Available}
        onBunkerUri={setBunkerUri}
        onExtension={handleExtension}
        onBunker={handleBunker}
        onNostrConnect={handleNostrConnect}
        onCancelConnect={cancelNostrConnect}
        onRetryVerify={handleRetryVerify}
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
  const healthById = new Map(
    (serviceHealth?.services ?? []).map((entry) => [entry.serviceId, entry]),
  );
  const healthLoading = healthState === 'idle' || healthState === 'loading';
  const loadingRecords = refreshing || (snapshot === null && !recordsError);
  const refresh = () => {
    setRecordsError('');
    setRefreshing(true);
    setRefreshToken((value) => value + 1);
    setMetricsToken((value) => value + 1);
  };

  const refreshHealth = () => {
    setControlError('');
    setHealthState('loading');
    setHealthError('');
    setHealthToken((value) => value + 1);
  };

  const refreshLogs = () => {
    setLogsState('loading');
    setLogsError('');
    setLogsToken((value) => value + 1);
  };

  const closeLogs = () => {
    setLogsFor(null);
    setServiceLogs(null);
    setLogsState('idle');
    setLogsError('');
  };

  const openLogs = (service: PanelService) => {
    const health = (serviceHealth?.services ?? []).find((entry) => entry.serviceId === service.id);
    setLogsTab(health?.container ? 'container' : 'node');
    setServiceLogs(null);
    setLogsState('loading');
    setLogsError('');
    setLogsFor(service);
    setLogsToken((value) => value + 1);
  };

  const refreshCatalogue = () => {
    catalogueRefresh.current = true;
    setCatalogueError('');
    setCatalogueWarning('');
    setCatalogueState('loading');
    setCatalogueToken((value) => value + 1);
  };

  const refreshImages = () => {
    setImageError('');
    setImageDone('');
    setNodeImagesState('loading');
    imagesForce.current = true;
    setImagesToken((value) => value + 1);
  };

  const startImageUpdate = async (services: string[], label: string) => {
    if (!apiBase || !user || services.length === 0) return;

    setConfirmUpdate(null);
    setConfirmUpdateAll(false);
    setImageError('');
    setImageDone('');
    setImageStarting(true);
    setImageBusy(services.length === 1 ? services[0] : null);

    try {
      const started = await updatePanelImages(apiBase, user.signer, services);
      const startedServices = started.services.length ? started.services : services;

      // Reflect the accepted work locally so no card invites the same pull
      // again. A token means the panel can follow the real states; without one
      // (older sidecar) the list waits for Check images.
      setNodeImages((current) => current ? {
        ...current,
        updating: true,
        images: current.images.map((entry) => startedServices.includes(entry.service)
          ? {
            ...entry,
            updateAvailable: false,
            update: { state: 'queued', changed: false, imageId: null, error: null },
          }
          : entry),
      } : current);

      if (started.progressToken) {
        setImageProgress(null);
        setProgressToken(started.progressToken);
      } else {
        setImageDone(`${label}: update started. Reload the list in a moment to see the new digest.`);
      }
    } catch (error) {
      setImageError(error instanceof Error ? error.message : `Could not update ${label}`);
    } finally {
      setImageStarting(false);
      setImageBusy(null);
    }
  };

  const handleUpdateImage = async (image: PanelNodeImage) => {
    if (!apiBase || !user) return;

    if (confirmUpdate !== image.service) {
      setConfirmUpdate(image.service);
      setConfirmUpdateAll(false);
      notify(`Click Update again to pull ${image.label}`);
      return;
    }

    await startImageUpdate([image.service], image.label);
  };

  const handleUpdateAll = async () => {
    if (!apiBase || !user || !nodeImages) return;

    const services = nodeImages.images
      .filter((image) => image.updatable && image.updateAvailable === true)
      .map((image) => image.service);
    if (!services.length) return;

    if (!confirmUpdateAll) {
      setConfirmUpdateAll(true);
      setConfirmUpdate(null);
      notify(`Click Update all again to pull ${services.length} images`);
      return;
    }

    await startImageUpdate(services, `${services.length} image${services.length === 1 ? '' : 's'}`);
  };

  const openRelease = (entry: PanelCatalogueEntry) => {
    setReleaseDetails(null);
    setReleaseError('');
    setReleaseState('loading');
    setSelectedRelease(entry);
    setReleaseToken((value) => value + 1);
  };

  const closeRelease = () => {
    setSelectedRelease(null);
    setReleaseDetails(null);
    setReleaseState('idle');
    setReleaseError('');
    setTrustBusy(false);
  };

  const handleTrustPublisher = async (entry: PanelCatalogueEntry, trusted: boolean) => {
    if (!apiBase || !user) return;

    setTrustBusy(true);
    setReleaseError('');
    try {
      const publishers = await setPanelCatalogueTrust(apiBase, user.signer, entry.publisher, trusted);
      const trustedKeys = new Set(publishers.map((publisher) => publisher.publisher));
      setCatalogue((current) => current ? {
        ...current,
        trusted: publishers,
        entries: current.entries.map((item) => ({
          ...item,
          trusted: item.publisher === entry.publisher ? trusted : trustedKeys.has(item.publisher),
        })),
      } : current);
      setSelectedRelease((current) => current && current.publisher === entry.publisher
        ? { ...current, trusted }
        : current);
      notify(trusted ? 'Publisher trusted' : 'Publisher untrusted');
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : 'Could not update the publisher trust list');
    } finally {
      setTrustBusy(false);
    }
  };

  const handleRepublish = async (service: PanelService) => {
    if (!apiBase || !user) return;

    setControlError('');
    setControlBusy(`republish:${service.id}`);
    try {
      await republishPanelService(apiBase, user.signer, service.id);
      notify(`${serviceMeta(service.id).label} republished`);
      refreshHealth();
      refresh();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'Could not republish the service');
    } finally {
      setControlBusy(null);
    }
  };

  const handleRestart = async (service: PanelService) => {
    if (!apiBase || !user) return;

    if (confirmRestart !== service.id) {
      setConfirmRestart(service.id);
      notify('Click Restart again to confirm');
      return;
    }

    setConfirmRestart(null);
    setControlError('');
    setControlBusy(`restart:${service.id}`);
    try {
      const result = await restartPanelService(apiBase, user.signer, service.id);
      const names = result.containers.map((container) => container.name).join(', ');
      notify(names ? `Restarting ${names}` : 'Restart requested');
      window.setTimeout(refreshHealth, 2500);
    } catch (error) {
      // Restarting caddy can cut the response that is proxied through it.
      // The agent restarts after replying, but a network failure still means
      // the request may have been accepted.
      const mappedToCaddy = service.id === 'web' || service.id === 'addr' || service.id === 'admin';
      if (mappedToCaddy && error instanceof PanelApiError && error.status === 0) {
        notify('Restart requested; reload if the page briefly stops responding');
        window.setTimeout(refreshHealth, 3000);
      } else {
        setControlError(error instanceof Error ? error.message : 'Could not restart the service');
      }
    } finally {
      setControlBusy(null);
    }
  };
  const publishedCount = services.filter((service) => service.status === 'published').length;
  const expiredCount = services.filter((service) => service.status === 'expired').length;
  const connectedRelays = snapshot?.relays.filter((relay) => relay.connected).length ?? 0;
  const relayTotal = readRelays.length;
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

  const catalogueEntries = catalogue?.entries ?? [];
  const catalogueCategories = [...new Set(
    catalogueEntries.flatMap((entry) => entry.categories),
  )].sort((left, right) => left.localeCompare(right));
  const filteredCatalog = catalogueEntries.filter((entry) => {
    const needle = appQuery.trim().toLowerCase();
    const haystack = `${entry.name} ${entry.summary ?? ''} ${entry.description ?? ''} `
      + `${entry.categories.join(' ')} ${entry.publisher}`;
    const matchesQuery = !needle || haystack.toLowerCase().includes(needle);
    const matchesCategory = appCategory === 'all'
      || entry.categories.some((category) => category.toLowerCase() === appCategory.toLowerCase());
    return matchesQuery && matchesCategory;
  });
  const catalogueHeading = catalogue?.available
    ? `${filteredCatalog.length} AVAILABLE`
    : 'CATALOGUE UNAVAILABLE';
  const catalogueLoading = catalogueState === 'idle' || catalogueState === 'loading';
  const releaseHomepage = selectedRelease ? safeLink(selectedRelease.homepage) : null;
  const releaseSupport = selectedRelease ? safeLink(selectedRelease.supportUrl) : null;

  const adminRows: PanelAdmin[] = admins ?? (operatorNpub
    ? [{ npub: operatorNpub, pubkey: operatorPubkey ?? '', status: 'active', createdAt: null }]
    : []);
  const apiAvailable = Boolean(apiBase);
  const adminsLoading = Boolean(apiAvailable && authorized && admins === null && adminsState !== 'error');
  const canManageAdmins = Boolean(apiAvailable && authorized && user && admins !== null);

  const settingsLoading = Boolean(apiAvailable && authorized && settings === null && settingsState !== 'error');
  const canEditSettings = Boolean(apiAvailable && authorized && user && settings !== null);
  const relaysChanged = Boolean(settings && relayDraft.join('\n') !== settings.relays.join('\n'));
  const identityChanged = Boolean(settings && (
    identityDraft.displayName.trim() !== settings.identity.displayName
    || identityDraft.about.trim() !== settings.identity.about
    || identityDraft.picture.trim() !== settings.identity.picture
    || identityDraft.nip05.trim() !== settings.identity.nip05
  ));
  const cadenceChanged = Boolean(settings && (
    cadenceFromText(cadenceText).refreshIntervalMinutes !== settings.cadence.refreshIntervalMinutes
    || cadenceFromText(cadenceText).ncc02ExpiryDays !== settings.cadence.ncc02ExpiryDays
    || cadenceFromText(cadenceText).ncc05TtlHours !== settings.cadence.ncc05TtlHours
  ));
  const relayReportByUrl = new Map((snapshot?.relays ?? []).map((report) => [report.url, report]));
  const nextCadence = cadenceFromText(cadenceText);
  const settingsUnavailable = !apiAvailable || (settingsState === 'error' && settings === null);
  const displayedRelays = settings ? relayDraft : (config?.relays ?? []);

  const storage = metrics?.storage?.totalBytes ? metrics.storage : null;
  const memory = metrics?.memory?.totalBytes ? metrics.memory : null;
  const cpu = metrics?.cpu ?? null;
  const dockerUsage = metrics?.docker ?? null;
  const storagePercent = storage?.usedPercent ?? null;
  const metricsUnavailable = metricsState === 'error' || (metrics !== null && !metrics.available);
  const metricsNote = metrics?.error ?? (metricsState === 'error' ? metricsError : '');

  const groups = activityGroups(snapshot?.activity ?? []);
  const recentActivity = snapshot?.activity.slice(0, 3) ?? [];

  const imageUpdateCount = nodeImages?.images
    .filter((image) => image.updatable && image.updateAvailable === true)
    .length ?? 0;
  const imagesUpdating = nodeImages?.updating === true || imageProgress?.inProgress === true;
  const imageLabels = new Map((nodeImages?.images ?? []).map((image) => [image.service, image.label]));
  const progressActive = imageProgress?.services.find(
    (entry) => entry.state === 'pulling' || entry.state === 'recreating',
  );
  const progressFailed = imageProgress?.services.filter((entry) => entry.state === 'failed') ?? [];
  const progressUnknown = imageProgress?.services.filter((entry) => entry.state === 'unknown').length ?? 0;
  const imageProgressLabel = imageProgress?.error
    ? imageProgress.error
    : imageProgress?.inProgress
      ? progressActive
        ? `${progressActive.state === 'pulling' ? 'Pulling' : 'Recreating'} ${imageLabels.get(progressActive.service) ?? progressActive.service}`
        : 'Waiting for the node-agent…'
      : progressUnknown
        ? 'The node-agent did not report these images. Press Check images.'
        : progressFailed.length
          ? `Finished with ${progressFailed.length} failed. Press Check images to refresh.`
          : 'Finished. Press Check images to refresh the digests.';

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
            <div className="storage-top">
              <HardDrive size={15} />
              <span>Storage</span>
              <span className="storage-value">
                {storagePercent === null ? '—' : `${Math.round(storagePercent)}%`}
              </span>
            </div>
            <div
              className="storage-track"
              role={storage ? 'progressbar' : undefined}
              aria-valuemin={storage ? 0 : undefined}
              aria-valuemax={storage ? 100 : undefined}
              aria-valuenow={storage ? Math.round(storagePercent ?? 0) : undefined}
              aria-label={storage ? 'Host disk used' : undefined}
            >
              <i style={{ width: `${storagePercent ?? 0}%` }} />
            </div>
            <small title={metricsNote || undefined}>
              {storage
                ? `${formatBytes(storage.freeBytes)} free of ${formatBytes(storage.totalBytes)}`
                : metricsState === 'loading'
                  ? 'Reading host metrics…'
                  : metricsUnavailable
                    ? 'Host metrics unavailable'
                    : 'Host metrics have not loaded yet'}
            </small>
            {dockerUsage?.totalBytes ? (
              <small className="storage-docker" title="Images, containers, volumes and build cache">
                Docker data {formatBytes(dockerUsage.totalBytes)}
              </small>
            ) : null}
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
            <ThemeControl />
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
                  <div className="metric-foot">Queried by the node from its relays</div>
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
                  <div>
                    <h2>Node resources</h2>
                    <p>Host CPU, memory and disk, collected by the node agent</p>
                  </div>
                  <span className="resource-collected">
                    {metricsState === 'loading' && !metrics
                      ? 'Reading…'
                      : metrics?.collectedAt
                        ? `Collected ${relativeTime(metrics.collectedAt)}`
                        : 'Not collected'}
                  </span>
                </div>

                {!metrics && metricsState === 'loading' ? (
                  <div className="empty-state">Reading host metrics…</div>
                ) : metricsUnavailable ? (
                  <div className="empty-state">
                    {metricsRouteMissing
                      ? 'This sidecar image does not serve host metrics. Recreate it with the matching SIDECAR_IMAGE.'
                      : `The node agent did not report host metrics${metricsNote ? `: ${metricsNote}` : ''}. Container controls use the same agent.`}
                    <button className="text-button" onClick={refresh} disabled={refreshing}>Try again</button>
                  </div>
                ) : (
                  <div className="resource-grid">
                    <div className="resource-card">
                      <div className="resource-head"><span>CPU LOAD</span><Cpu size={15} /></div>
                      <div className="resource-value">
                        {cpu?.load1 === null || cpu?.load1 === undefined
                          ? 'unknown'
                          : cpu.load1.toFixed(2)}
                        {cpu?.cores ? <small> · {cpu.cores} cores</small> : null}
                      </div>
                      <div className="resource-foot">
                        {cpu?.load5 === null || cpu?.load5 === undefined
                          ? 'Load average unavailable'
                          : `5 min ${cpu.load5.toFixed(2)} · 15 min ${cpu.load15 === null || cpu.load15 === undefined ? '—' : cpu.load15.toFixed(2)}`}
                      </div>
                    </div>

                    <div className="resource-card">
                      <div className="resource-head"><span>MEMORY</span><MemoryStick size={15} /></div>
                      <div className="resource-value">
                        {memory?.usedPercent === null || memory?.usedPercent === undefined
                          ? 'unknown'
                          : `${Math.round(memory.usedPercent)}%`}
                        {memory?.totalBytes ? <small> · {formatBytes(memory.totalBytes)}</small> : null}
                      </div>
                      <div
                        className="resource-track"
                        role={memory ? 'progressbar' : undefined}
                        aria-valuemin={memory ? 0 : undefined}
                        aria-valuemax={memory ? 100 : undefined}
                        aria-valuenow={memory ? Math.round(memory.usedPercent ?? 0) : undefined}
                        aria-label={memory ? 'Host memory used' : undefined}
                      >
                        <i style={{ width: `${memory?.usedPercent ?? 0}%` }} />
                      </div>
                      <div className="resource-foot">
                        {memory
                          ? `${formatBytes(memory.usedBytes)} used · ${formatBytes(memory.availableBytes)} available`
                          : 'Memory usage unavailable'}
                      </div>
                    </div>

                    <div className="resource-card">
                      <div className="resource-head"><span>DISK</span><HardDrive size={15} /></div>
                      <div className="resource-value">
                        {storagePercent === null ? 'unknown' : `${Math.round(storagePercent)}%`}
                        {storage?.totalBytes ? <small> · {formatBytes(storage.totalBytes)}</small> : null}
                      </div>
                      <div
                        className="resource-track"
                        role={storage ? 'progressbar' : undefined}
                        aria-valuemin={storage ? 0 : undefined}
                        aria-valuemax={storage ? 100 : undefined}
                        aria-valuenow={storage ? Math.round(storagePercent ?? 0) : undefined}
                        aria-label={storage ? 'Host disk used' : undefined}
                      >
                        <i style={{ width: `${storagePercent ?? 0}%` }} />
                      </div>
                      <div className="resource-foot">
                        {storage
                          ? `${formatBytes(storage.freeBytes)} free${dockerUsage?.totalBytes ? ` · Docker data ${formatBytes(dockerUsage.totalBytes)}` : ''}`
                          : 'Disk usage unavailable'}
                      </div>
                    </div>
                  </div>
                )}
              </section>

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
                          <button className="icon-quiet" onClick={() => setSection('Installed')} aria-label={`Manage ${meta.label}`} title="Open installed services">
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
              <div className="content-section node-images-section">
                <div className="section-heading">
                  <div>
                    <h2>Node images</h2>
                    <p>
                      The bundle&apos;s own containers. Updating pulls the image tag and recreates
                      the container only when the digest changed.
                    </p>
                  </div>
                  <div className="heading-actions">
                    <AppsViewToggle value={appsView} onChange={setAppsView} />
                    <button
                      className="button-primary update-all"
                      type="button"
                      onClick={handleUpdateAll}
                      disabled={
                        !authorized || !apiBase || !user || imageUpdateCount === 0
                        || imageStarting || imagesUpdating
                      }
                      title={imageUpdateCount === 0
                        ? 'Every image is already up to date'
                        : `Pull ${imageUpdateCount} image${imageUpdateCount === 1 ? '' : 's'} with a newer registry digest`}
                    >
                      {imageStarting ? <span className="button-spinner" /> : <ArrowDownToLine size={14} />}
                      {imageProgress?.inProgress
                        ? `Updating (${imageProgress.total})`
                        : imageStarting
                          ? 'Starting…'
                          : confirmUpdateAll
                            ? `Confirm all (${imageUpdateCount})`
                            : `Update all (${imageUpdateCount})`}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={refreshImages}
                      disabled={nodeImagesState === 'loading' || !apiBase || imagesUpdating}
                      title="Read the current image and last update result from the node"
                    >
                      <RefreshCw size={13} className={nodeImagesState === 'loading' ? 'spin' : undefined} />
                      Check images
                    </button>
                  </div>
                </div>

                {imageError && (
                  <div className="panel-banner error" role="alert">
                    <CircleAlert size={14} />
                    <span>{imageError}</span>
                    <button className="text-button" onClick={() => setImageError('')}>Dismiss</button>
                  </div>
                )}

                {imageDone && (
                  <div className="settings-saved" role="status"><Check size={13} /> {imageDone}</div>
                )}

                {imageProgress && (
                  <div className={`image-progress ${imageProgress.inProgress ? 'active' : ''}`} role="status">
                    <div className="image-progress-head">
                      <strong>
                        {imageProgress.inProgress
                          ? 'Updating images'
                          : progressUnknown
                            ? 'Update status unavailable'
                            : 'Image update finished'}
                      </strong>
                      <span>{imageProgress.done} / {imageProgress.total}</span>
                    </div>
                    <div
                      className="image-progress-track"
                      role="progressbar"
                      aria-label="Image update progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={imageProgress.percent}
                      aria-valuetext={`${imageProgress.done} of ${imageProgress.total} images updated`}
                    >
                      <i style={{ width: `${Math.min(100, Math.max(0, imageProgress.percent))}%` }} />
                    </div>
                    <div className="image-progress-detail">
                      <span className={imageProgress.error ? 'health-bad' : undefined}>{imageProgressLabel}</span>
                      {progressFailed.length > 0 && (
                        <span className="image-progress-failed">
                          {progressFailed.length} failed
                        </span>
                      )}
                      {!imageProgress.inProgress && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setImageProgress(null)}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {nodeImagesState === 'error' && (
                  <div className="panel-banner error" role="alert">
                    <CircleAlert size={14} />
                    <span>Could not read the node images: {nodeImagesError}</span>
                    <button className="text-button" onClick={refreshImages}>Try again</button>
                  </div>
                )}

                {nodeImages && !nodeImages.agent.available && nodeImagesState !== 'error' && (
                  <div className="panel-banner" role="status">
                    <CircleAlert size={14} />
                    <span>
                      Image updates need the node-agent on this host
                      {nodeImages.agent.error ? `: ${nodeImages.agent.error}` : ''}.
                    </span>
                  </div>
                )}

                {nodeImages?.error && (
                  <div className="panel-banner error" role="alert">
                    <CircleAlert size={14} />
                    <span>The last image update reported: {nodeImages.error}</span>
                  </div>
                )}

                {nodeImages?.updating && !imageProgress && (
                  <div className="panel-banner" role="status">
                    <CircleAlert size={14} />
                    <span>
                      An image update is running on the node. Pulling can take a few minutes;
                      check the list again when it finishes.
                    </span>
                  </div>
                )}

                {nodeImagesState === 'loading' && !nodeImages ? (
                  <div className="empty-state">Reading the node&apos;s images…</div>
                ) : !nodeImages || nodeImages.images.length === 0 ? (
                  <div className="empty-state">
                    No bundle containers were found. Start the node-agent to list and update
                    this server&apos;s images.
                  </div>
                ) : (
                  <div className={`node-image-grid view-${appsView}`}>
                    {nodeImages.images.map((image) => {
                      const status = imageUpdateCopy(image);
                      const busy = imageBusy === image.service;
                      const checked = imageCheckedLabel(image.checkedAt);
                      // A completed pull/recreate is newer than the digest check
                      // that was read before it; hide the action until the panel
                      // checks again. A fresh "available" answer always wins, so
                      // a release published after the last pull is not hidden.
                      const settled = (image.update?.state === 'recreated' || image.update?.state === 'current')
                        && image.updateAvailable !== true;
                      const available = settled ? false : image.updateAvailable;
                      const fallback = image.updatable && available === null;
                      const offerUpdate = image.updatable && available !== false;
                      const canUpdate = Boolean(
                        authorized && apiBase && user && offerUpdate
                        && imageBusy === null && !imageStarting && !nodeImages.updating,
                      );

                      return (
                        <article className="node-image-card" key={image.service}>
                          <div className="node-image-head">
                            <div className="node-image-title">
                              <strong>{image.label}</strong>
                              <small>{image.role === 'core' ? 'NCC service' : 'Infrastructure'}</small>
                            </div>
                            <span className={`status-pill ${image.state === 'running' ? '' : 'stopped'}`}>
                              <i />{image.state === 'running' ? 'Running' : image.state}
                            </span>
                          </div>

                          <p>{image.description}</p>

                          <code className="node-image-ref" title={image.image ?? undefined}>
                            {image.image ?? 'No image reported'}
                          </code>

                          <div className="node-image-meta">
                            <span>{image.tag ? `tag ${image.tag}` : 'digest pin'}</span>
                            <span>{image.imageId ? `image ${shortImageId(image.imageId)}` : 'image unknown'}</span>
                            {imageBuiltLabel(image.imageCreatedAt) && (
                              <span>built {imageBuiltLabel(image.imageCreatedAt)}</span>
                            )}
                            {checked && <span>checked {checked}</span>}
                          </div>

                          <div className={`node-image-status ${status.tone}`} title={image.checkError ?? image.update?.error ?? undefined}>
                            {status.text}
                          </div>

                          {offerUpdate ? (
                            <div className="node-image-actions">
                              <button
                                className={fallback ? 'text-button' : 'catalog-install'}
                                type="button"
                                onClick={() => handleUpdateImage(image)}
                                disabled={!canUpdate || busy}
                                title={fallback
                                  ? 'The registry check did not answer; pull this tag anyway'
                                  : 'Pull this image tag and recreate the container when the digest changed'}
                              >
                                {busy ? <span className="button-spinner dark" /> : <ArrowDownToLine size={14} />}
                                {busy
                                  ? 'Starting…'
                                  : confirmUpdate === image.service
                                    ? 'Confirm update'
                                    : fallback ? 'Pull anyway' : 'Update'}
                              </button>
                              {confirmUpdate === image.service && (
                                <button
                                  className="text-button"
                                  type="button"
                                  onClick={() => setConfirmUpdate(null)}
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}

                <div className="catalog-note">
                  <Shield size={17} />
                  <span>
                    <strong>Pinned tags stay pinned.</strong> An update pulls the tag the container
                    runs, so <code>latest</code> follows new releases but a pinned version only
                    moves when you change it on the host. Updating Caddy, the sidecar or the
                    node-agent briefly interrupts this panel.
                  </span>
                </div>
              </div>

              <div className="page-heading">
                <div>
                  <div className="eyebrow">APP CATALOGUE <span>·</span> NOSTR PACKAGES</div>
                  <h1>Give your server a new purpose.</h1>
                  <p>Signed service packages discovered from relays. Installing one is a single verified command.</p>
                </div>
                <span className="catalog-count">{catalogueHeading}</span>
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
                <select
                  className="catalog-select"
                  aria-label="Filter by category"
                  value={appCategory}
                  onChange={(event) => setAppCategory(event.target.value)}
                >
                  <option value="all">All categories</option>
                  {catalogueCategories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <button
                  className="package-button"
                  onClick={refreshCatalogue}
                  disabled={catalogueLoading || !apiBase}
                  title="Ask the npack service to rebuild its catalogue from relays"
                >
                  <RefreshCw size={15} className={catalogueLoading ? 'spin' : undefined} /> Refresh catalogue
                </button>
                <AppsViewToggle value={appsView} onChange={setAppsView} />
              </div>

              {catalogueState === 'error' && (
                <div className="panel-banner error" role="alert">
                  <CircleAlert size={14} />
                  <span>Could not read the App catalogue: {catalogueError}</span>
                  <button className="text-button" onClick={refreshCatalogue}>Try again</button>
                </div>
              )}

              {catalogueWarning && catalogueState !== 'error' && (
                <div className="panel-banner" role="status">
                  <CircleAlert size={14} />
                  <span>{catalogueWarning}</span>
                </div>
              )}

              {catalogue?.refreshError && catalogueState !== 'error' && (
                <div className="panel-banner error" role="alert">
                  <CircleAlert size={14} />
                  <span>Could not refresh the App catalogue: {catalogue.refreshError}</span>
                  <button className="text-button" onClick={refreshCatalogue}>Try again</button>
                </div>
              )}

              {catalogue?.refreshing && !catalogueLoading && catalogueState !== 'error' && (
                <div className="panel-banner" role="status">
                  <CircleAlert size={14} />
                  <span>
                    The npack service is still querying relays. The list below is from its last
                    successful refresh; check again in a minute.
                  </span>
                </div>
              )}

              {catalogue && !catalogue.available && catalogueState !== 'error' && (
                <div className="panel-banner" role="status">
                  <CircleAlert size={14} />
                  <span>
                    The App catalogue needs the npack service on this host
                    {catalogue.error ? `: ${catalogue.error}` : ''}. Other panel sections keep working.
                  </span>
                </div>
              )}

              {catalogueLoading && catalogueEntries.length === 0 ? (
                <div className="empty-state">Reading service packages from relays…</div>
              ) : filteredCatalog.length === 0 ? (
                <div className="empty-state">
                  {catalogue?.available
                    ? 'No published service packages match this search.'
                    : 'No service packages were found on the configured relays.'}
                </div>
              ) : (
                <div className={`catalog-grid view-${appsView}`}>
                  {filteredCatalog.map((entry) => (
                    <article className="catalog-card" key={entry.releaseEventId}>
                      <div className="catalog-card-top">
                        {apiBase && user
                          ? <ReleaseIcon base={apiBase} signer={user.signer} release={entry} />
                          : <IconBox icon={Layers3} tint="green" />}
                        <span className="category-tag">{entry.categories[0] ?? 'SERVICE'}</span>
                      </div>
                      <h3>{entry.name}</h3>
                      <p>{entry.summary ?? entry.description ?? 'No description was published.'}</p>
                      <div className="catalog-meta">
                        <span title={entry.npub ?? entry.publisher}>
                          {publisherLabel(entry)} · v{entry.version}
                        </span>
                        <button onClick={() => openRelease(entry)}>Details <ArrowUpRight size={12} /></button>
                      </div>
                      <button className="catalog-install" onClick={() => openRelease(entry)}>
                        <ArrowDownToLine size={15} /> Review &amp; install
                      </button>
                    </article>
                  ))}
                </div>
              )}

              <div className="catalog-note">
                <Shield size={17} />
                <span>
                  <strong>Signed by their publisher.</strong> Entries come from npack release events and
                  Blossom artifacts; this node verifies the release signature and artifact hash before
                  installing, then pulls the image from its registry. Catalogue updated {catalogueAge(catalogue)}.
                </span>
              </div>
            </>
          )}

          {section === 'Installed' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CONTAINER MANAGEMENT</div>
                  <h1>Installed services</h1>
                  <p>Published records for this node, with live health and container controls.</p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button-secondary"
                    onClick={refreshHealth}
                    disabled={healthLoading || !apiBase}
                    title="Probe every service and read its container state"
                  >
                    <RefreshCw size={15} className={healthLoading ? 'spin' : undefined} /> Check health
                  </button>
                  <button className="button-primary" onClick={() => setSection('Apps')}><Plus size={16} /> Add a service</button>
                </div>
              </div>

              {controlError && (
                <div className="panel-banner error" role="alert">
                  <CircleAlert size={14} />
                  <span>{controlError}</span>
                  <button className="text-button" onClick={() => setControlError('')}>Dismiss</button>
                </div>
              )}

              {healthState === 'error' && (
                <div className="panel-banner error" role="alert">
                  <CircleAlert size={14} />
                  <span>Could not read service health: {healthError}</span>
                  <button className="text-button" onClick={refreshHealth}>Try again</button>
                </div>
              )}

              {serviceHealth && !serviceHealth.agent.available && (
                <div className="panel-banner" role="status">
                  <CircleAlert size={14} />
                  <span>
                    Container controls need the node-agent service on the host
                    {serviceHealth.agent.error ? `: ${serviceHealth.agent.error}` : ''}.
                    Health still uses local probes and published records.
                  </span>
                </div>
              )}

              {loadingRecords && services.length === 0 ? (
                <div className="empty-state">Reading published services…</div>
              ) : services.length === 0 ? (
                <div className="empty-state">No NCC service records were found on the configured relays.</div>
              ) : (
                <div className="installed-list">
                  {services.map((service) => {
                    const meta = serviceMeta(service.id);
                    const status = statusCopy(service);
                    const health = healthById.get(service.id);
                    const healthLabel = healthCopy(health, healthLoading);
                    const nccHref = nccServiceAddress(operatorNpub, service.id);
                    const href = nccHref ?? safeHref(service.endpoint);
                    const canControl = Boolean(authorized && apiBase && user);
                    const restartBusy = controlBusy === `restart:${service.id}`;
                    const republishBusy = controlBusy === `republish:${service.id}`;
                    const canRestart = canControl && Boolean(health?.restartable) && !healthLoading;
                    const restartTitle = !canControl
                      ? 'Sign in to control services'
                      : healthLoading
                        ? 'Checking health…'
                        : !health
                          ? 'Service health is unavailable from this node'
                          : health.restartable
                            ? `Restart ${health.container?.names.join(', ') || 'the service'}`
                            : 'No restartable container is mapped to this service';

                    return (
                      <article className="installed-card" key={service.id}>
                        <div className="installed-main">
                          <IconBox icon={meta.icon} tint={meta.tint} />
                          <div className="service-name">
                            <div className="installed-title">
                              <strong>{meta.label}</strong>
                              <span className={`status-pill ${status.tone}`}><i />{status.label}</span>
                            </div>
                            <small>
                              {health?.package?.version
                                ? `npack v${health.package.version}${health.package.npub ? ` · ${shortNpub(health.package.npub)}` : ''}`
                                : service.pin ? `pin ${service.pin.slice(0, 16)}…` : 'No certificate pin published'}
                            </small>
                          </div>
                        </div>
                        <div className="installed-details">
                          <div><span>PUBLIC ENDPOINT</span><strong>{service.endpoint ?? 'Not published'}</strong></div>
                          <div>
                            <span>HEALTH</span>
                            <strong className={healthLabel.tone} title={healthLabel.detail || undefined}>
                              {healthLabel.label}
                            </strong>
                          </div>
                          <div><span>PUBLICATION</span><strong>{status.label} · {expiryLabel(service)}</strong></div>
                        </div>
                        <div className="installed-actions">
                          <button
                            onClick={() => openLogs(service)}
                            disabled={!canControl}
                            title={canControl ? 'Show recent container output and node events' : 'Sign in to read service logs'}
                          >
                            <TerminalSquare size={14} /> Logs
                          </button>
                          <button
                            onClick={() => handleRestart(service)}
                            disabled={!canRestart || controlBusy !== null}
                            title={restartTitle}
                          >
                            {restartBusy ? <span className="button-spinner" /> : <Activity size={14} />}
                            {confirmRestart === service.id ? 'Confirm restart' : restartBusy ? 'Restarting…' : 'Restart'}
                          </button>
                          <button
                            onClick={() => handleRepublish(service)}
                            disabled={!canControl || controlBusy !== null}
                            title={canControl ? 'Force a publish cycle for this service now' : 'Sign in to republish services'}
                          >
                            {republishBusy ? <span className="button-spinner" /> : <Radio size={14} />}
                            {republishBusy ? 'Republishing…' : 'Republish'}
                          </button>
                          {href ? (
                            <a
                              className="external-action"
                              href={href}
                              title={nccHref ? 'Open in NCC Browser' : 'Open the published endpoint'}
                              {...(nccHref ? {} : { target: '_blank', rel: 'noreferrer' })}
                            >
                              <ExternalLink size={14} /> Open endpoint
                            </a>
                          ) : (
                            <button className="external-action" disabled title="No service address is published">
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
                  <p>Admins sign in with their Nostr key. The node stores the list, and every change is signed by you.</p>
                </div>
              </div>

              <div className="admin-callout">
                <div className="callout-shield"><ShieldCheck size={20} /></div>
                <div>
                  <strong>{apiAvailable ? 'Access follows the node admin list.' : 'Admin management is inactive on this node.'}</strong>
                  <p>
                    {apiAvailable
                      ? 'Each request is authorized by a NIP-98 signature from your signer. Adding or removing a key also updates its npanel administrator role.'
                      : 'This node does not serve /ncc-api yet. Deploy the current sidecar and Caddy images to manage keys from this panel.'}
                  </p>
                </div>
                <span>{apiAvailable ? 'NIP-98 SIGNED' : 'INACTIVE'}</span>
              </div>

              <section className="admin-section">
                <div className="section-heading">
                  <div>
                    <h2>Node administrators <span className="count-chip">{adminRows.length}</span></h2>
                    <p>{admins ? 'Keys that can open this panel and administer npanel.' : 'Verified operator for this node.'}</p>
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
                    const npanelRole = admin.npanelRole;
                    const canGrant = Boolean(
                      npanelRole !== undefined
                      && npanelRole !== 'admin'
                      && !owner
                      && canManageAdmins,
                    );

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
                        <span className="admin-access">
                          <span className={`admin-state ${admin.status === 'pending' ? 'pending' : ''}`}>
                            <i />{owner ? 'Owner · verified' : admin.status === 'pending' ? 'Invited' : 'Admin'}
                          </span>
                          {npanelRole !== undefined && (
                            <span
                              className={`npanel-state ${npanelRole ?? 'none'}`}
                              title={owner && npanelRole !== 'admin'
                                ? 'Make the operator key an npanel admin on the host; the panel cannot bootstrap that itself'
                                : undefined}
                            >
                              {npanelRole === 'admin'
                                ? 'Npanel admin'
                                : npanelRole === 'staff'
                                  ? 'Npanel staff'
                                  : 'No npanel access'}
                              {canGrant && (
                                <button
                                  type="button"
                                  disabled={adminBusy}
                                  title="Grant npanel administrator access to this key"
                                  onClick={() => handleGrantNpanel(admin)}
                                >
                                  {grantingPubkey === admin.pubkey ? 'Granting…' : 'Grant'}
                                </button>
                              )}
                            </span>
                          )}
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

                {npanelStatus?.configured && npanelStatus.available === false && (
                  <div className="invite-warning" role="status">
                    <CircleAlert size={13} />
                    <span>
                      Npanel access could not be read: {npanelStatus.error ?? 'npanel did not answer'}.
                      Keys can still be managed here.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAdmins(null);
                        setAdminsState('idle');
                        setAdminsError('');
                        setAdminsToken((value) => value + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}

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
                        ? 'Allow another Nostr key to open this panel, manage the node and administer npanel.'
                        : 'Adding another key needs the sidecar admin API, which this node does not serve yet.'}
                    </p>
                  </div>
                  {settingsUnavailable && <span className="inactive-badge">INACTIVE</span>}
                </div>
                <form onSubmit={handleInvite}>
                  <label htmlFor="admin-npub">OPERATOR PUBLIC KEY</label>
                  <div className="invite-input-row">
                    <input
                      id="admin-npub"
                      value={inviteNpub}
                      onChange={(event) => {
                        setInviteNpub(event.target.value);
                        setInviteDone('');
                        setInviteError('');
                        setInviteWarning('');
                      }}
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
                  {inviteWarning && (
                    <p className="invite-warning" role="status"><CircleAlert size={12} /> {inviteWarning}</p>
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
                    ? 'An admin key works only while it stays in the node admin list. Removing a key takes effect immediately and demotes its npanel role to staff.'
                    : 'This panel reads the operator key from the node config. Admin management stays inactive until the node serves /ncc-api.'}
                </span>
              </div>
            </>
          )}

          {section === 'Settings' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">NODE CONFIGURATION <span>·</span> {apiAvailable ? 'SIGNED WRITES' : 'READ-ONLY'}</div>
                  <h1>Settings for this server.</h1>
                  <p>
                    {apiAvailable
                      ? 'The identity, relays and cadence this node publishes on Nostr.'
                      : 'The identity and records this node publishes on Nostr. Saving needs the node admin API.'}
                  </p>
                </div>
                {apiAvailable && (
                  <div className="heading-actions">
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={settingsBusy !== null}
                      onClick={() => {
                        setSettings(null);
                        setSettingsState('idle');
                        setSettingsDone('');
                        setSettingsError('');
                        setSettingsToken((value) => value + 1);
                      }}
                    >
                      <RefreshCw size={14} className={settingsLoading ? 'spin' : undefined} /> Reload
                    </button>
                  </div>
                )}
              </div>

              {settingsError && (
                <div className="panel-banner error" role="alert">
                  <CircleAlert size={14} />
                  <span>Could not read the node settings: {settingsError}</span>
                </div>
              )}

              {settingsDone && (
                <div className="settings-saved" role="status"><Check size={13} /> {settingsDone}</div>
              )}

              <div className="settings-grid">
                <section className="settings-card">
                  <div className="settings-card-title">
                    <Globe2 size={17} />
                    <div><h2>Public identity</h2><p>The kind 0 profile clients see for this node.</p></div>
                    {settingsUnavailable && <span className="inactive-badge">INACTIVE</span>}
                  </div>
                  <label>OPERATOR NPUB</label>
                  <div className="settings-readonly">
                    <span>{shortNpub(operatorNpub)}</span>
                    <button className="icon-quiet" onClick={() => copy(operatorNpub, 'Operator npub')} aria-label="Copy operator npub"><Copy size={14} /></button>
                  </div>

                  <div className="settings-fields">
                    <label htmlFor="identity-display-name">DISPLAY NAME</label>
                    <input
                      id="identity-display-name"
                      value={identityDraft.displayName}
                      onChange={(event) => { setIdentityDraft({ ...identityDraft, displayName: event.target.value }); setIdentityError(''); setSettingsDone(''); }}
                      placeholder="My community node"
                      maxLength={64}
                      autoComplete="off"
                      disabled={!canEditSettings || settingsBusy !== null}
                    />

                    <label htmlFor="identity-nip05">NIP-05 ADDRESS</label>
                    <input
                      id="identity-nip05"
                      value={identityDraft.nip05}
                      onChange={(event) => { setIdentityDraft({ ...identityDraft, nip05: event.target.value }); setIdentityError(''); setSettingsDone(''); }}
                      placeholder="name@example.com"
                      maxLength={128}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canEditSettings || settingsBusy !== null}
                    />

                    <label htmlFor="identity-about">ABOUT</label>
                    <textarea
                      id="identity-about"
                      value={identityDraft.about}
                      onChange={(event) => { setIdentityDraft({ ...identityDraft, about: event.target.value }); setIdentityError(''); setSettingsDone(''); }}
                      placeholder="What this node is for."
                      rows={3}
                      maxLength={500}
                      disabled={!canEditSettings || settingsBusy !== null}
                    />

                    <label htmlFor="identity-picture">PICTURE URL</label>
                    <input
                      id="identity-picture"
                      value={identityDraft.picture}
                      onChange={(event) => { setIdentityDraft({ ...identityDraft, picture: event.target.value }); setIdentityError(''); setSettingsDone(''); }}
                      placeholder="https://example.com/avatar.png"
                      maxLength={400}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canEditSettings || settingsBusy !== null}
                    />
                  </div>

                  <label>PUBLIC ADDRESS</label>
                  <div className="settings-readonly">
                    <span>{publicHosts[0] ?? 'Not published'}</span>
                  </div>
                  {publicHosts.length > 1 && <small className="settings-hint">{publicHosts.length} endpoints published across services.</small>}

                  {identityError && (
                    <p className="invite-error" role="alert"><CircleAlert size={12} /> {identityError}</p>
                  )}

                  <div className="settings-actions">
                    <button
                      className="button-primary"
                      type="button"
                      onClick={handleSaveIdentity}
                      disabled={!canEditSettings || settingsBusy !== null || !identityChanged}
                    >
                      {settingsBusy === 'identity' ? <span className="button-spinner" /> : <Check size={14} />}
                      {settingsBusy === 'identity' ? 'Saving…' : 'Save identity'}
                    </button>
                    <span className="settings-status">
                      {settingsLoading
                        ? 'Reading…'
                        : settings
                          ? (settings.identity.published ? 'Kind 0 published' : 'Not published yet')
                          : 'Node settings unavailable'}
                    </span>
                  </div>
                  {settingsUnavailable && <small className="settings-hint">Saving stays inactive until the node serves /ncc-api.</small>}
                </section>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <Radio size={17} />
                    <div><h2>Publication relays</h2><p>Where this node publishes and reads its records. Reachability is checked by the node.</p></div>
                    {settingsUnavailable && <span className="inactive-badge">INACTIVE</span>}
                  </div>

                  {settingsLoading && (
                    <span className="admin-loading" role="status"><span className="button-spinner dark" /> Reading relays…</span>
                  )}

                  {displayedRelays.map((url) => {
                    const report = relayReportByUrl.get(url);
                    const records = report ? report.anchorCount + report.locatorCount : 0;
                    return (
                      <div className="relay-setting" key={url}>
                        <i className={`relay-dot ${report && !report.connected ? 'off' : ''}`} />
                        <span>
                          <strong>{new URL(url).host}</strong>
                          <small>{url}</small>
                        </span>
                        <span className={`relay-state ${report && !report.connected ? 'off' : ''}`}>
                          {report ? (report.connected ? `${records} records` : 'Unreachable') : 'Saved'}
                        </span>
                        <button
                          className="icon-quiet"
                          type="button"
                          onClick={() => handleRemoveRelay(url)}
                          disabled={!canEditSettings || settingsBusy !== null}
                          aria-label={`Remove relay ${url}`}
                          title="Remove this relay"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}

                  <div className="invite-input-row settings-add-relay">
                    <input
                      aria-label="Add a publication relay"
                      value={newRelay}
                      onChange={(event) => { setNewRelay(event.target.value); setRelayError(''); setSettingsDone(''); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleAddRelay();
                        }
                      }}
                      placeholder="wss://relay.example/"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canEditSettings || settingsBusy !== null}
                    />
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={handleAddRelay}
                      disabled={!canEditSettings || settingsBusy !== null || newRelay.trim().length === 0}
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>

                  {relayError && (
                    <p className="invite-error" role="alert"><CircleAlert size={12} /> {relayError}</p>
                  )}

                  <div className="settings-actions">
                    <button
                      className="button-primary"
                      type="button"
                      onClick={handleSaveRelays}
                      disabled={!canEditSettings || settingsBusy !== null || !relaysChanged}
                    >
                      {settingsBusy === 'relays' ? <span className="button-spinner" /> : <Check size={14} />}
                      {settingsBusy === 'relays' ? 'Saving…' : 'Save relays'}
                    </button>
                    <span className="settings-status">
                      {relayDraft.length} relay{relayDraft.length === 1 ? '' : 's'} · anchors and locators
                    </span>
                  </div>
                  {settingsUnavailable && <small className="settings-hint">Saving stays inactive until the node serves /ncc-api.</small>}
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
                    <div><h2>Publication cadence</h2><p>How often the node refreshes anchors and locators.</p></div>
                    {settingsUnavailable && <span className="inactive-badge">INACTIVE</span>}
                  </div>

                  <div className="cadence-grid">
                    <label htmlFor="cadence-refresh">
                      PUBLISH INTERVAL
                      <span>
                        <input
                          id="cadence-refresh"
                          inputMode="numeric"
                          value={cadenceText.refreshIntervalMinutes}
                          onChange={(event) => { setCadenceText({ ...cadenceText, refreshIntervalMinutes: event.target.value }); setCadenceError(''); setSettingsDone(''); }}
                          disabled={!canEditSettings || settingsBusy !== null}
                        />
                        min
                      </span>
                    </label>
                    <label htmlFor="cadence-ttl">
                      LOCATOR TTL
                      <span>
                        <input
                          id="cadence-ttl"
                          inputMode="numeric"
                          value={cadenceText.ncc05TtlHours}
                          onChange={(event) => { setCadenceText({ ...cadenceText, ncc05TtlHours: event.target.value }); setCadenceError(''); setSettingsDone(''); }}
                          disabled={!canEditSettings || settingsBusy !== null}
                        />
                        hr
                      </span>
                    </label>
                    <label htmlFor="cadence-expiry">
                      RECORD EXPIRY
                      <span>
                        <input
                          id="cadence-expiry"
                          inputMode="numeric"
                          value={cadenceText.ncc02ExpiryDays}
                          onChange={(event) => { setCadenceText({ ...cadenceText, ncc02ExpiryDays: event.target.value }); setCadenceError(''); setSettingsDone(''); }}
                          disabled={!canEditSettings || settingsBusy !== null}
                        />
                        days
                      </span>
                    </label>
                  </div>

                  <div className="settings-inline"><span>Refreshes every</span><strong>{Number.isFinite(nextCadence.refreshIntervalMinutes) ? durationLabel(nextCadence.refreshIntervalMinutes * 60) : '—'}</strong></div>
                  <div className="settings-inline"><span>Locator valid for</span><strong>{Number.isFinite(nextCadence.ncc05TtlHours) ? durationLabel(nextCadence.ncc05TtlHours * 3600) : '—'}</strong></div>
                  <div className="settings-inline"><span>Record valid for</span><strong>{Number.isFinite(nextCadence.ncc02ExpiryDays) ? durationLabel(nextCadence.ncc02ExpiryDays * 86400) : '—'}</strong></div>
                  <div className="settings-inline">
                    <span>Latest record</span>
                    <strong>{loadingRecords ? 'Reading…' : snapshot?.latestPublishedAt ? relativeTime(snapshot.latestPublishedAt) : '—'}</strong>
                  </div>
                  <div className="settings-inline">
                    <span>Services publishing</span>
                    <strong>{settingsLoading ? 'Reading…' : settings?.publication.services ?? services.length}</strong>
                  </div>

                  {cadenceError && (
                    <p className="invite-error" role="alert"><CircleAlert size={12} /> {cadenceError}</p>
                  )}

                  <div className="settings-actions">
                    <button
                      className="button-primary"
                      type="button"
                      onClick={handleSaveCadence}
                      disabled={!canEditSettings || settingsBusy !== null || !cadenceChanged}
                    >
                      {settingsBusy === 'cadence' ? <span className="button-spinner" /> : <Check size={14} />}
                      {settingsBusy === 'cadence' ? 'Saving…' : 'Save cadence'}
                    </button>
                    <span className="settings-status">{locatorTtl === null ? 'No locator TTL published' : `${durationLabel(locatorTtl)} locator TTL live`}</span>
                  </div>
                  {settingsUnavailable && <small className="settings-hint">Saving stays inactive until the node serves /ncc-api.</small>}
                </section>
              </div>
            </>
          )}
        </div>
      </main>

      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

      {selectedRelease && (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeRelease(); }}
        >
          <section className="install-modal catalog-modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
            <div className="modal-top">
              <div className="eyebrow">
                SERVICE PACKAGE <span>·</span>{' '}
                {selectedRelease.official
                  ? 'OFFICIAL PUBLISHER'
                  : selectedRelease.trusted ? 'TRUSTED PUBLISHER' : 'UNKNOWN PUBLISHER'}
              </div>
              <button className="icon-quiet" onClick={closeRelease} aria-label="Close"><X size={19} /></button>
            </div>
            <h2 id="install-title">{selectedRelease.name}</h2>
            <p className="modal-intro">
              {selectedRelease.summary ?? selectedRelease.description ?? 'No description was published.'}
            </p>

            {releaseError && (
              <div className="panel-banner error" role="alert">
                <CircleAlert size={14} />
                <span>{releaseError}</span>
              </div>
            )}

            <div className="install-spec">
              <div><span>PUBLISHER</span><strong title={selectedRelease.npub ?? selectedRelease.publisher}>{shortPublisher(selectedRelease)}</strong></div>
              <div><span>VERSION</span><strong>v{selectedRelease.version}</strong></div>
              <div><span>PACKAGE HASH</span><strong>{selectedRelease.sha256 ? `${selectedRelease.sha256.slice(0, 16)}…` : '—'}</strong></div>
              <div>
                <span>PLATFORM</span>
                <strong>
                  {releaseDetails
                    ? `${releaseDetails.provenance.os ?? 'linux'}/${releaseDetails.provenance.arch ?? 'x86_64'}`
                    : selectedRelease.compatible ? 'Compatible' : 'Other platform'}
                </strong>
              </div>
              {releaseDetails && (
                <>
                  <div><span>CONTAINER IMAGE</span><strong className="mono-wrap">{releaseDetails.descriptor.image}</strong></div>
                  <div><span>PUBLIC PORT</span><strong>{releaseDetails.descriptor.publicPort ?? '—'}</strong></div>
                  <div>
                    <span>BACKEND</span>
                    <strong>
                      127.0.0.1:{releaseDetails.descriptor.backendPort ?? '—'} → {releaseDetails.descriptor.containerPort ?? '—'}
                    </strong>
                  </div>
                  <div><span>PROBE</span><strong>{releaseDetails.descriptor.probePath}</strong></div>
                  <div><span>LICENCE</span><strong>{selectedRelease.license ?? 'Not stated'}</strong></div>
                  <div><span>DOWNLOAD</span><strong>{byteSize(selectedRelease.downloadSize) ?? 'Not stated'}</strong></div>
                </>
              )}
            </div>

            {releaseState === 'loading' && (
              <p className="empty-note">Downloading and verifying the package…</p>
            )}

            {releaseDetails?.warnings.map((warning) => (
              <div className="panel-banner" role="status" key={warning}>
                <CircleAlert size={14} />
                <span>{warning}</span>
              </div>
            ))}

            {releaseDetails && (releaseDetails.descriptor.volumes.length > 0
              || releaseDetails.descriptor.envKeys.length > 0) && (
              <div className="install-spec">
                {releaseDetails.descriptor.volumes.length > 0 && (
                  <div>
                    <span>PERSISTENT VOLUMES</span>
                    <strong>
                      {releaseDetails.descriptor.volumes
                        .map((volume) => `${volume.name} → ${volume.path}`)
                        .join(' · ')}
                    </strong>
                  </div>
                )}
                {releaseDetails.descriptor.envKeys.length > 0 && (
                  <div>
                    <span>ENVIRONMENT</span>
                    <strong>{releaseDetails.descriptor.envKeys.join(', ')}</strong>
                  </div>
                )}
                {releaseDetails.descriptor.minBundleVersion && (
                  <div>
                    <span>MINIMUM BUNDLE</span>
                    <strong>{releaseDetails.descriptor.minBundleVersion}</strong>
                  </div>
                )}
              </div>
            )}

            {selectedRelease.description && selectedRelease.description !== selectedRelease.summary && (
              <p className="modal-copy">{selectedRelease.description}</p>
            )}

            {releaseDetails?.readme && (
              <pre className="catalog-readme">{releaseDetails.readme}</pre>
            )}

            <div className="install-security">
              <LockKeyhole size={15} />
              <span>
                Installed with a read-only filesystem, no added capabilities and one loopback port.
                The container image is pulled from its registry; npack supplies only the signed descriptor.
              </span>
            </div>

            {!selectedRelease.official && (
              <div className="catalogue-trust">
                <div>
                  <strong>{selectedRelease.trusted ? 'Trusted publisher' : 'Unknown publisher'}</strong>
                  <small>{selectedRelease.npub ?? selectedRelease.publisher}</small>
                </div>
                <button
                  className="button-secondary"
                  onClick={() => handleTrustPublisher(selectedRelease, !selectedRelease.trusted)}
                  disabled={trustBusy || !apiBase || !user}
                >
                  {trustBusy
                    ? <span className="button-spinner" />
                    : selectedRelease.trusted ? <Trash2 size={14} /> : <ShieldCheck size={14} />}
                  {selectedRelease.trusted ? 'Stop trusting' : 'Trust publisher'}
                </button>
              </div>
            )}

            <div className="catalog-command">
              <span>INSTALL ON THE HOST</span>
              <code>{installCommand(selectedRelease)}</code>
              <button
                className="text-button"
                onClick={() => copy(installCommand(selectedRelease), 'Install command')}
              >
                <Copy size={13} /> Copy
              </button>
            </div>

            <div className="modal-buttons">
              {releaseHomepage && (
                <a className="button-secondary" href={releaseHomepage} target="_blank" rel="noreferrer">
                  Homepage <ExternalLink size={13} />
                </a>
              )}
              {releaseSupport && (
                <a className="button-secondary" href={releaseSupport} target="_blank" rel="noreferrer">
                  Support <ExternalLink size={13} />
                </a>
              )}
              <button className="button-secondary" onClick={closeRelease}>Close</button>
            </div>
          </section>
        </div>
      )}

      {logsFor && (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeLogs(); }}
        >
          <section className="install-modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
            <div className="modal-top">
              <div className="eyebrow">SERVICE LOGS <span>·</span> {serviceMeta(logsFor.id).label}</div>
              <button className="icon-quiet" onClick={closeLogs} aria-label="Close logs" autoFocus><X size={19} /></button>
            </div>
            <h2 id="logs-title">{serviceMeta(logsFor.id).label} logs</h2>
            <p className="modal-intro">Recent container output and node events for this service.</p>

            <div className="logs-tabs" role="tablist" aria-label="Log source">
              <button
                role="tab"
                aria-selected={logsTab === 'container'}
                className={`logs-tab ${logsTab === 'container' ? 'active' : ''}`}
                onClick={() => setLogsTab('container')}
              >
                Container output
              </button>
              <button
                role="tab"
                aria-selected={logsTab === 'node'}
                className={`logs-tab ${logsTab === 'node' ? 'active' : ''}`}
                onClick={() => setLogsTab('node')}
              >
                Node events
              </button>
            </div>

            <div className="logs-body" role="tabpanel">
              {logsState === 'loading' ? (
                <p className="log-empty">Reading logs…</p>
              ) : logsState === 'error' ? (
                <p className="log-empty log-error">{logsError}</p>
              ) : logsTab === 'container' ? (
                !serviceLogs?.container.available ? (
                  <p className="log-empty">
                    {serviceLogs?.container.error ?? 'Container output is unavailable on this install.'}
                  </p>
                ) : serviceLogs.container.logs.length === 0 ? (
                  <p className="log-empty">No container output in the recent window.</p>
                ) : (
                  serviceLogs.container.logs.map((line, index) => (
                    <div className="log-line" key={`${line.container}-${line.timestamp}-${index}`}>
                      <time>{logTimestamp(line.timestamp)}</time>
                      <span className={`log-level ${line.stream}`}>{line.stream}</span>
                      <code>{line.message}</code>
                    </div>
                  ))
                )
              ) : serviceLogs?.node.length ? (
                serviceLogs.node.map((line, index) => (
                  <div className="log-line" key={`${line.timestamp}-${index}`}>
                    <time>{logTimestamp(line.timestamp)}</time>
                    <span className={`log-level ${line.level}`}>{line.level}</span>
                    <code title={line.metadata ? JSON.stringify(line.metadata) : undefined}>{line.message}</code>
                  </div>
                ))
              ) : (
                <p className="log-empty">No node events are recorded for this service yet.</p>
              )}
            </div>

            <div className="modal-buttons">
              <button
                className="button-secondary"
                onClick={refreshLogs}
                disabled={logsState === 'loading'}
              >
                <RefreshCw size={14} className={logsState === 'loading' ? 'spin' : undefined} /> Refresh
              </button>
              <button className="button-secondary" onClick={closeLogs}>Close</button>
            </div>
          </section>
        </div>
      )}

      {notice && <div className="toast-note"><Check size={15} />{notice}</div>}
    </div>
  );
}
