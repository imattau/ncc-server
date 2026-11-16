import { useState } from 'react';
import { nip19 } from 'nostr-tools';
import { UserRound } from 'lucide-react';

import { useAuthor } from '@/hooks/useAuthor';
import { sanitizeHref } from '@/lib/sanitize';

// NIP-07 only -- no nsec/bunker/extension-chooser dialog like test-app's
// full LoginArea. This app never publishes, so there's nothing for those
// other signer types to do here beyond identifying a pubkey, and a
// browser-extension signer is the simplest way to do only that.
//
// Controlled by the caller (SearchPage), not calling useNip07Login() itself:
// this component is rendered twice (landing view + compact header), and two
// independent hook instances would each have their own state -- signing out
// via one would leave the other (and SearchPage's own `pubkey`, which drives
// useFollows/useInterests) stuck showing stale "signed in" state. Caught
// this live: clicking "sign out" flipped the button back to "Sign in" but
// left the personalization notice text saying "Signed in" underneath it,
// because that text read a second, unsynced hook instance.
export function LoginButton({
  pubkey,
  onSignIn,
  onSignOut,
}: {
  pubkey: string | null;
  onSignIn: () => Promise<unknown>;
  onSignOut: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
  const author = useAuthor(pubkey ?? undefined);

  async function handleSignIn() {
    setError(null);
    try {
      await onSignIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    }
  }

  if (pubkey) {
    let npub = pubkey;
    try {
      npub = nip19.npubEncode(pubkey);
    } catch {
      // fall back to the raw hex pubkey if encoding somehow fails
    }
    const picture = sanitizeHref(author.data?.metadata?.picture);
    const displayName = author.data?.metadata?.display_name || author.data?.metadata?.name || npub;
    return (
      <button
        type="button"
        onClick={onSignOut}
        title={`Signed in as ${npub} -- click to sign out`}
        aria-label={`Signed in as ${npub}. Click to sign out`}
        className="flex shrink-0 items-center gap-2 rounded-full text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {picture && failedPicture !== picture ? (
          <img
            src={picture}
            alt=""
            onError={() => setFailedPicture(picture)}
            className="size-8 rounded-full border border-border object-cover"
          />
        ) : (
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserRound className="size-4" />
          </span>
        )}
        <span className="hidden max-w-32 truncate sm:inline">{displayName}</span>
        <span className="hidden sm:inline">· Sign out</span>
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={handleSignIn}
        className="whitespace-nowrap text-xs text-blue-700 hover:underline dark:text-blue-400"
      >
        Sign in
      </button>
      {error && <span className="text-xs text-muted-foreground">{error}</span>}
    </div>
  );
}
