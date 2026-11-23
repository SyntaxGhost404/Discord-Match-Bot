// Text hygiene for everything users type: invisible-character stripping,
// length limits, markdown escaping for display, link detection and
// profanity checks (via the `obscenity` library, which handles leetspeak
// without the classic "Scunthorpe" false positives).

import {
  RegExpMatcher,
  TextCensor,
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

// Zero-width, bidi-override and other invisible formatting characters.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-︎﻿ﾠ]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** One line of user input: no control/invisible chars, collapsed spaces. */
export function sanitizeLine(input: string, maxLength: number): string {
  return input
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Multi-line input: keeps line breaks (max `maxLines` lines, no blank runs). */
export function sanitizeMultiline(input: string, maxLength: number, maxLines = 8): string {
  const lines = input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (!line && (!kept.length || !kept[kept.length - 1])) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.slice(0, maxLines).join('\n').slice(0, maxLength).trim();
}

/** Escapes Discord markdown, mentions and timestamps so text renders literally. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#\-[\]()<:@])/g, '\\$1');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Prefixes every line with "> " for a Discord block quote. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// -- links -----------------------------------------------------------------------

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b(?:discord(?:app)?\.(?:gg|com|io|me|li)\/(?:invite\/)?\S+)|\b[a-z0-9-]{2,}\.(?:com|net|org|gg|io|me|co|xyz|app|dev|ly|tv|ru|uk|de|link|site|online|store|shop|info|biz)(?:\/\S*)?/gi;

export function containsLink(text: string): boolean {
  LINK.lastIndex = 0;
  return LINK.test(text);
}

export function stripLinks(text: string, replacement = '[link removed]'): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(LINK, () => {
    removed++;
    return replacement;
  });
  return { text: out, removed };
}

// -- profanity -------------------------------------------------------------------

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

export function containsProfanity(text: string): boolean {
  return matcher.hasMatch(text);
}

export function censorProfanity(text: string): { text: string; censored: boolean } {
  const matches = matcher.getAllMatches(text);
  if (!matches.length) return { text, censored: false };
  return { text: censor.applyTo(text, matches), censored: true };
}

// -- validation of profile fields ------------------------------------------------

export type TextProblem = 'too_short' | 'too_long' | 'link' | 'profanity' | 'mention' | 'no_letters';

export function checkDisplayName(name: string): TextProblem | null {
  if (name.length < 2) return 'too_short';
  if (name.length > 32) return 'too_long';
  if (!/\p{L}/u.test(name)) return 'no_letters';
  if (/[@<>#]|discord/i.test(name)) return 'mention';
  if (containsLink(name)) return 'link';
  if (containsProfanity(name)) return 'profanity';
  return null;
}

export function checkFreeText(text: string): TextProblem | null {
  if (!text) return null;
  if (containsLink(text)) return 'link';
  if (containsProfanity(text)) return 'profanity';
  return null;
}

export function describeTextProblem(problem: TextProblem, field: string): string {
  switch (problem) {
    case 'too_short':
      return `Your ${field} needs at least 2 characters.`;
    case 'too_long':
      return `Your ${field} is too long.`;
    case 'no_letters':
      return `Your ${field} needs at least one letter.`;
    case 'mention':
      return `Your ${field} can't contain @, #, < >, or the word "discord".`;
    case 'link':
      return `Links and invites aren't allowed in your ${field}. Share contacts after you match instead.`;
    case 'profanity':
      return `Please keep your ${field} friendly. It looks like it contains offensive language.`;
  }
}
