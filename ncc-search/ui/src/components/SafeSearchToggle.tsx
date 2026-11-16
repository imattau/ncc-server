import { Shield, ShieldOff } from 'lucide-react';

export function SafeSearchToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Safe search is on -- click to turn off' : 'Safe search is off -- click to turn on'}
      title={enabled ? 'Safe search: on' : 'Safe search: off'}
      className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {enabled ? <Shield className="size-3.5" /> : <ShieldOff className="size-3.5" />}
      <span className="hidden sm:inline">Safe search</span>
      <span className="sm:hidden">Safe</span>
    </button>
  );
}
