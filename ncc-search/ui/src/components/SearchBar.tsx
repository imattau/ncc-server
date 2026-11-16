import { useRef, type SubmitEvent } from 'react';
import { Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SearchBarProps {
  defaultValue: string;
  onSubmit: (value: string) => void;
  size?: 'hero' | 'compact';
  className?: string;
  autoFocus?: boolean;
}

export function SearchBar({
  defaultValue,
  onSubmit,
  size = 'hero',
  className,
  autoFocus,
}: SearchBarProps) {
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = (new FormData(event.currentTarget).get('q') as string | null)?.trim() ?? '';
    onSubmit(value);
  }

  return (
    <div className={cn('w-full', className)}>
      <form
        ref={formRef}
        role="search"
        onSubmit={handleSubmit}
        // `border-border` (used for subtle hairlines elsewhere, e.g.
        // dividers between results) is far too light against a white
        // background to see on its own -- it's ~91% lightness, barely
        // distinguishable from the page itself. `border-muted-foreground`
        // (~4.85:1 against white, comfortably over WCAG 1.4.11's 3:1 floor
        // for UI component boundaries) is what actually makes the search
        // box's own edge visible as a shape, not just inferred from its
        // shadow. `focus-within:border-foreground` gives a clearly visible
        // focus state too, since the `<input>` itself has `outline-none`
        // (WCAG 2.4.7 needs a visible substitute, not just a shadow change).
        className={cn(
          'flex w-full items-center gap-3 rounded-full border border-muted-foreground/70 bg-background px-4 shadow-sm transition-colors hover:border-muted-foreground focus-within:border-foreground focus-within:shadow-md',
          size === 'hero' ? 'h-14 sm:px-5' : 'h-10',
        )}
      >
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          name="q"
          type="search"
          key={defaultValue}
          defaultValue={defaultValue}
          placeholder="Search npubs, nip05 handles, service and site names…"
          autoFocus={autoFocus}
          className={cn(
            'h-full rounded-none border-0 bg-transparent px-0 text-foreground shadow-none focus-visible:border-0 focus-visible:ring-0',
            size === 'hero' ? 'text-base' : 'text-sm',
          )}
          aria-label="Search"
        />
      </form>

      {/* A visible submit button, the way a real search engine's homepage has
          one even though Enter also works -- discoverable for anyone who
          doesn't try the keyboard first. */}
      {size === 'hero' && (
        <div className="mt-6 flex justify-center">
          <Button
            type="button"
            variant="secondary"
            onClick={() => formRef.current?.requestSubmit()}
            className="border border-border px-5 hover:border-muted-foreground/30"
          >
            Search
          </Button>
        </div>
      )}
    </div>
  );
}
