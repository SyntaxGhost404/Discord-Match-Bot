// custom_id format: "<namespace>:<action>[:<arg>...]".
//
// Arguments are restricted to a safe alphabet (ids, numbers, short keys), and
// the total length is checked against Discord's 100-character limit at build
// time, so a malformed id is a programming error caught by tests — never a
// runtime surprise. Handlers always re-validate state server-side; a custom_id
// only says what the user clicked, never what they are allowed to do.

const PART = /^[A-Za-z0-9_.-]+$/;

export interface ParsedCustomId {
  ns: string;
  action: string;
  args: string[];
}

export function cid(ns: string, action: string, ...args: Array<string | number>): string {
  const parts = [ns, action, ...args.map(String)];
  for (const part of parts) {
    if (!PART.test(part)) throw new Error(`Invalid custom_id part "${part}" in ${parts.join(':')}`);
  }
  const id = parts.join(':');
  if (id.length > 100) throw new Error(`custom_id longer than 100 characters: ${id}`);
  return id;
}

export function parseCustomId(id: string | undefined): ParsedCustomId | null {
  if (!id || id.length > 100) return null;
  const parts = id.split(':');
  if (parts.length < 2 || parts.some((p) => !PART.test(p))) return null;
  const [ns, action, ...args] = parts as [string, string, ...string[]];
  return { ns, action, args };
}
