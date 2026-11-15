import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { NostrPoolProvider } from '@/components/NostrPoolProvider';
import { SearchPage } from '@/pages/SearchPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NostrPoolProvider>
        <SearchPage />
      </NostrPoolProvider>
    </QueryClientProvider>
  );
}

export default App;
