import { useState } from 'react';
import { nip19 } from 'nostr-tools';

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
    return (
      <button
        type="button"
        onClick={onSignOut}
        title={`Signed in as ${npub} -- click to sign out`}
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground"
      >
        {npub.slice(0, 12)}… · sign out
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
