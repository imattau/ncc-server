export interface PostedAtEvent {
  kind?: number;
  created_at?: number;
  tags?: string[][];
}

export function postedAtOf(event: PostedAtEvent): number | null;
