import type { ReactNode } from 'react';
import { NostrContext } from '@nostrify/react';

import { nostrPool } from '@/lib/nostrPool';

export function NostrPoolProvider({ children }: { children: ReactNode }) {
  return <NostrContext.Provider value={{ nostr: nostrPool }}>{children}</NostrContext.Provider>;
}
