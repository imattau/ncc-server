import { ArrowDown, ArrowDownAZ, ArrowUp, ArrowUpAZ, CalendarDays } from 'lucide-react';

import type { SearchSort } from '@/lib/api';
import { cn } from '@/lib/utils';

// The sort control is three fields, not five buttons: "Best match" is the
// backend's relevance order, and Date/A-Z each carry their own direction,
// which is what pressing the active field cycles. That keeps the default
// visible (you can always get back to relevance) and means a sort never
// silently stays on a hidden direction.
const BUTTON = 'flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 transition-colors';
const ACTIVE = 'bg-background font-medium text-foreground shadow-sm';
const INACTIVE = 'text-muted-foreground hover:text-foreground';

function fieldOf(sort: SearchSort): 'relevance' | 'date' | 'title' {
  if (sort === 'newest' || sort === 'oldest') return 'date';
  if (sort === 'title' || sort === 'title-desc') return 'title';
  return 'relevance';
}

export function SortControl({
  sort,
  onChange,
}: {
  sort: SearchSort;
  onChange: (sort: SearchSort) => void;
}) {
  const field = fieldOf(sort);
  // The direction each field starts in when it is first chosen.
  const newestFirst = sort !== 'oldest';
  const alphabetical = sort !== 'title-desc';

  const dateLabel =
    field === 'date'
      ? newestFirst
        ? 'Date, newest first -- click for oldest first'
        : 'Date, oldest first -- click for newest first'
      : 'Sort by date, newest first';
  const titleLabel =
    field === 'title'
      ? alphabetical
        ? 'A to Z -- click for Z to A'
        : 'Z to A -- click for A to Z'
      : 'Sort alphabetically, A to Z';

  return (
    <div
      role="group"
      aria-label="Sort results"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 text-xs"
    >
      <button
        type="button"
        onClick={() => onChange('relevance')}
        aria-pressed={field === 'relevance'}
        title="Sort by best match"
        className={cn(BUTTON, field === 'relevance' ? ACTIVE : INACTIVE)}
      >
        <span className="sm:hidden">Best</span>
        <span className="hidden sm:inline">Best match</span>
      </button>

      <button
        type="button"
        onClick={() => onChange(field === 'date' && newestFirst ? 'oldest' : 'newest')}
        aria-pressed={field === 'date'}
        aria-label={dateLabel}
        title={dateLabel}
        className={cn(BUTTON, field === 'date' ? ACTIVE : INACTIVE)}
      >
        <CalendarDays className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Date</span>
        {field === 'date' &&
          (newestFirst ? (
            <ArrowDown className="size-3" aria-hidden="true" />
          ) : (
            <ArrowUp className="size-3" aria-hidden="true" />
          ))}
      </button>

      <button
        type="button"
        onClick={() => onChange(field === 'title' && alphabetical ? 'title-desc' : 'title')}
        aria-pressed={field === 'title'}
        aria-label={titleLabel}
        title={titleLabel}
        className={cn(BUTTON, field === 'title' ? ACTIVE : INACTIVE)}
      >
        {alphabetical ? (
          <ArrowDownAZ className="size-3.5" aria-hidden="true" />
        ) : (
          <ArrowUpAZ className="size-3.5" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">A–Z</span>
      </button>
    </div>
  );
}
