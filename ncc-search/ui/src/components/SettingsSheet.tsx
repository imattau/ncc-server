import { useEffect, useId, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { Menu, X } from 'lucide-react';

import type { Theme } from '@/hooks/useTheme';
import type { useRelayPreference } from '@/hooks/useRelayPreference';
import { LocalIndexSettings } from '@/components/LocalIndexSettings';
import { truncateIdentity } from '@/lib/identity';
import { isLocalMode } from '@/lib/local/client';
import { cn } from '@/lib/utils';

export function SettingsButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open settings"
      aria-haspopup="dialog"
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-9 pointer-coarse:size-11',
        className,
      )}
    >
      <Menu className="size-5" aria-hidden="true" />
    </button>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2.5 border-b border-border py-5 first:pt-0 last:border-0 last:pb-0">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SettingsToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        disabled={disabled}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
          checked ? 'border-foreground bg-foreground' : 'border-border bg-muted',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-0.5 size-[18px] rounded-full bg-background shadow-sm transition-transform',
            checked ? 'left-[1.375rem]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

const RELAY_PILL =
  'min-h-11 flex-1 rounded-md border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-9 pointer-coarse:min-h-11';

export function SettingsSheet({
  open,
  onClose,
  pubkey,
  onSignIn,
  onSignOut,
  theme,
  onToggleTheme,
  safeSearch,
  onToggleSafeSearch,
  blurNsfw,
  onToggleBlurNsfw,
  relay,
}: {
  open: boolean;
  onClose: () => void;
  pubkey: string | null;
  onSignIn: () => Promise<unknown>;
  onSignOut: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  safeSearch: boolean;
  onToggleSafeSearch: () => void;
  blurNsfw: boolean;
  onToggleBlurNsfw: () => void;
  relay: ReturnType<typeof useRelayPreference>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const local = isLocalMode();
  const nip65 = relay.source === 'nip65';
  const [identity, setIdentity] = useState('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  async function handleSignIn() {
    setSignInError(null);
    setSigningIn(true);
    try {
      await onSignIn();
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setSigningIn(false);
    }
  }

  useEffect(() => {
    if (!pubkey) {
      setIdentity('');
      return;
    }
    try {
      setIdentity(truncateIdentity(nip19.npubEncode(pubkey)));
    } catch {
      setIdentity(truncateIdentity(pubkey));
    }
  }, [pubkey]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto max-h-[85dvh] w-[min(92vw,34rem)] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/60 max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 pointer-coarse:m-0 pointer-coarse:h-dvh pointer-coarse:max-h-none pointer-coarse:w-full pointer-coarse:max-w-none pointer-coarse:rounded-none pointer-coarse:border-0"
    >
      <div className="flex max-h-[85dvh] flex-col max-sm:h-dvh max-sm:max-h-none pointer-coarse:h-dvh pointer-coarse:max-h-none">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
          <h1 id={titleId} className="text-base font-semibold">Settings</h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="ml-auto inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-9 pointer-coarse:size-11"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          <Section
            title="Account"
            description="Signing in only identifies your pubkey for personalization and your relay list. This app never publishes and never asks for a secret key."
          >
            {pubkey ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 truncate text-sm text-foreground">{identity}</span>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="min-h-11 rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent sm:min-h-9 pointer-coarse:min-h-11"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={handleSignIn}
                  disabled={signingIn}
                  className="min-h-11 rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-60 sm:min-h-9 pointer-coarse:min-h-11"
                >
                  {signingIn ? 'Waiting for signer…' : 'Sign in with NIP-07'}
                </button>
                <span className="text-xs text-muted-foreground">
                  A browser extension such as Alby or nos2x is required.
                </span>
                {signInError && (
                  <p className="text-sm text-red-600 dark:text-red-400" role="alert">{signInError}</p>
                )}
              </div>
            )}
          </Section>

          <Section title="Appearance">
            <SettingsToggle
              label="Dark mode"
              description="Follows your system until you choose here; the choice is remembered."
              checked={theme === 'dark'}
              onChange={onToggleTheme}
            />
          </Section>

          <Section title="Search preferences">
            <SettingsToggle
              label="Safe search"
              description="Hides results whose publisher tagged them with a NIP-68/71 content warning. This app makes no safety judgment of its own."
              checked={safeSearch}
              onChange={onToggleSafeSearch}
            />
            <SettingsToggle
              label="Blur NSFW media"
              description="Blurs images, videos and shorts the publisher tagged NSFW or otherwise sensitive, until you click to reveal them. Useful with safe search off, where those results are shown instead of hidden."
              checked={blurNsfw}
              onChange={onToggleBlurNsfw}
            />
          </Section>

          <Section
            title="Relays"
            description={
              local
                ? 'Used to crawl relays in this browser and to look up names, previews and quotes.'
                : 'Your own relays are used for live search results and for names, previews and quotes. The node’s indexed results still come from its own crawl relays.'
            }
          >
            <div className="flex gap-2" role="group" aria-label="Relay source">
              <button
                type="button"
                aria-pressed={!nip65}
                onClick={relay.useSite}
                className={cn(
                  RELAY_PILL,
                  !nip65
                    ? 'border-foreground bg-foreground font-medium text-background'
                    : 'border-border text-foreground hover:bg-accent',
                )}
              >
                Site relays
              </button>
              <button
                type="button"
                aria-pressed={nip65}
                onClick={relay.useNip65}
                disabled={!pubkey || relay.loading}
                className={cn(
                  RELAY_PILL,
                  nip65
                    ? 'border-foreground bg-foreground font-medium text-background'
                    : 'border-border text-foreground hover:bg-accent',
                  (!pubkey || relay.loading) && 'opacity-50',
                )}
              >
                {relay.loading ? 'Looking up…' : 'My relay list (NIP-65)'}
              </button>
            </div>

            {!pubkey && (
              <p className="text-xs text-muted-foreground">Sign in to use your own Nostr relay list.</p>
            )}
            {relay.error && (
              <p className="text-sm text-amber-700 dark:text-amber-400" role="status">{relay.error}</p>
            )}
            {nip65 && relay.relays.length > 0 && (
              <div className="grid gap-1.5">
                <ul className="grid gap-1 rounded-md border border-border bg-muted/30 px-3 py-2">
                  {relay.relays.map((url) => (
                    <li key={url} className="truncate font-mono text-xs text-muted-foreground">{url}</li>
                  ))}
                </ul>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Read relays from your kind:10002 list.
                    {local
                      ? ' Up to six are crawled here.'
                      : ' All are used for names and previews; live search uses up to three.'}
                  </span>
                  <button
                    type="button"
                    onClick={relay.refresh}
                    disabled={relay.loading}
                    className="min-h-11 shrink-0 rounded-md px-2 text-sm font-medium text-blue-700 hover:underline disabled:opacity-50 sm:min-h-9 dark:text-blue-400 pointer-coarse:min-h-11"
                  >
                    Refresh
                  </button>
                </div>
              </div>
            )}
          </Section>

          {local && open && (
            <Section
              title="Local index"
              description="This copy crawls relays in your browser and keeps what it finds in IndexedDB. Nothing here is sent to a server."
            >
              <LocalIndexSettings nip65Active={nip65} />
            </Section>
          )}
        </div>
      </div>
    </dialog>
  );
}
