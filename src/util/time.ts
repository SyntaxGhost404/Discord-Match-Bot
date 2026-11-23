// Time helpers. Everything internal is epoch milliseconds; Discord renders
// `<t:seconds:style>` tags in each viewer's own timezone and locale.

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 's' | 'S' | 'R';

export function discordTimestamp(ms: number, style: TimestampStyle = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "45s", "3m", "1h 5m", "2d 4h" — compact human durations. */
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "45 seconds", "3 minutes", "1 hour 5 minutes". */
export function longDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (total < 60) return plural(total, 'second');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
}
