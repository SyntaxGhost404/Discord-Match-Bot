// Discord snowflake helpers.

export const DISCORD_EPOCH = 1420070400000n;
const SNOWFLAKE_RE = /^\d{15,21}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

/** Creation time (ms since Unix epoch) encoded in a snowflake. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Orders a pair of user ids so (a, b) and (b, a) map to the same row. */
export function orderedPair(a: string, b: string): [low: string, high: string] {
  return compareSnowflakes(a, b) <= 0 ? [a, b] : [b, a];
}

/** The larger of two snowflakes (null-safe). */
export function maxSnowflake(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareSnowflakes(a, b) >= 0 ? a : b;
}
