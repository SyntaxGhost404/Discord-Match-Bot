// Visual language: one accent color per area, used consistently.

export const Colors = {
  brand: 0xff6b8b,
  discover: 0xff6b8b,
  likes: 0xf43f87,
  match: 0xf5a623,
  chat: 0x5865f2,
  profile: 0x8b5cf6,
  settings: 0x64748b,
  help: 0x22a6b3,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  info: 0x5865f2,
  mod: 0xeb459e,
  muted: 0x4f545c,
} as const;

export type Tone = 'info' | 'success' | 'warning' | 'danger';

export const ToneColor: Record<Tone, number> = {
  info: Colors.info,
  success: Colors.success,
  warning: Colors.warning,
  danger: Colors.danger,
};

export const ToneEmoji: Record<Tone, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  danger: '⛔',
};
