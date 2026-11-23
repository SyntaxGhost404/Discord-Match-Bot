// The profile card: the heart of the bot's UI. One renderer for every place
// a profile appears, so it always looks the same.

import { container, gallery, separator, text } from '../discord/components/builders.ts';
import type { ActionRow, Container, ContainerChild } from '../discord/types.ts';
import { GENDERS, INTERESTS, LANGUAGES, LOOKING_FOR, describeKeys, findItem } from '../domain/catalog.ts';
import { sharedKeys } from '../domain/compatibility.ts';
import { photoUrl, profileAge, type Photo, type Profile } from '../domain/profile.ts';
import { escapeMarkdown, quote, truncate } from '../domain/text.ts';
import { Colors } from './theme.ts';

export interface ProfileCardOptions {
  now: number;
  /** When set, shared interests are highlighted and counted. */
  viewer?: Profile | null;
  /** Text above the profile (e.g. "💌 Alex liked you!"). */
  header?: string;
  /** A note attached to a like. */
  note?: string | null;
  /** Small print below the profile. */
  footer?: string;
  /** Show the Discord mention (only once identities are shared). */
  revealUserId?: string;
  rows?: ActionRow[];
  accent?: number;
  maxPhotos?: number;
}

/** The display name, escaped for markdown. */
export function profileName(profile: Pick<Profile, 'name'>): string {
  return escapeMarkdown(profile.name || 'Someone');
}

export function profileHeadline(profile: Profile, now: number): string {
  const age = profileAge(profile, now);
  return `${escapeMarkdown(profile.name || 'Someone')}${age !== null ? `, ${age}` : ''}`;
}

export function profileCard(profile: Profile, photos: Photo[], options: ProfileCardOptions): Container {
  const children: ContainerChild[] = [];
  if (options.header) children.push(text(options.header), separator({ divider: false }));

  const shown = photos.slice(0, options.maxPhotos ?? 6);
  if (shown.length) {
    children.push(
      gallery(shown.map((photo, i) => ({ url: photoUrl(photo), description: `Photo ${i + 1} of ${truncate(profile.name, 40)}` }))),
    );
  }

  const gender = findItem(GENDERS, profile.gender);
  const meta: string[] = [];
  if (gender && profile.gender !== 'unspecified') meta.push(`${gender.emoji} ${gender.label}`);
  if (profile.location) meta.push(`📍 ${escapeMarkdown(profile.location)}`);
  const languages = profile.languages.map((key) => findItem(LANGUAGES, key)?.label).filter(Boolean);
  if (languages.length) meta.push(`🗣️ ${languages.join(', ')}`);

  const lines = [`## ${profileHeadline(profile, options.now)}`];
  if (meta.length) lines.push(`-# ${meta.join(' · ')}`);
  if (profile.bio) lines.push(quote(escapeMarkdown(profile.bio)));
  children.push(text(lines.join('\n')));

  const viewer = options.viewer;
  const sharedInterests = new Set(viewer ? sharedKeys(viewer.interests, profile.interests) : []);
  const sharedGoals = new Set(viewer ? sharedKeys(viewer.lookingFor, profile.lookingFor) : []);
  const details: string[] = [];
  if (profile.interests.length) details.push(`**Into** ${describeKeys(INTERESTS, profile.interests, sharedInterests)}`);
  if (profile.lookingFor.length) details.push(`**Looking for** ${describeKeys(LOOKING_FOR, profile.lookingFor, sharedGoals)}`);
  const common = sharedInterests.size + sharedGoals.size;
  if (viewer && common > 0) details.push(`-# ✨ You have ${common} thing${common === 1 ? '' : 's'} in common`);
  if (details.length) children.push(text(details.join('\n')));

  if (options.note) children.push(text(`💬 **Their note**\n${quote(escapeMarkdown(options.note))}`));
  if (options.revealUserId) children.push(text(`👤 **Discord:** <@${options.revealUserId}>`));
  if (options.footer) children.push(text(`-# ${options.footer}`));
  if (options.rows?.length) children.push(separator(), ...options.rows);

  return container(children, { accent: options.accent ?? Colors.discover });
}
