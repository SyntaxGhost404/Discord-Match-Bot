// Profile and photo models shared by the database layer and the features.

import { CDN_BASE } from '../discord/constants.ts';
import type { Gender } from './catalog.ts';
import { ageGroupOf, ageOn, type AgeGroup } from './age.ts';

export type ProfileStage = 'basics' | 'confirm' | 'about' | 'photos' | 'review' | 'complete';
export type Visibility = 'visible' | 'paused' | 'hidden';

export interface Profile {
  userId: string;
  stage: ProfileStage;
  visibility: Visibility;
  name: string;
  birthDate: string | null;
  gender: Gender;
  bio: string;
  location: string;
  languages: string[];
  interests: string[];
  lookingFor: string[];
  showGenders: Gender[];
  ageMin: number | null;
  ageMax: number | null;
  sameLanguageOnly: boolean;
  likeAlerts: boolean;
  chatFilter: boolean;
  guidelinesAcceptedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastActiveAt: number;
}

export interface Photo {
  id: number;
  userId: string;
  position: number;
  channelId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  contentType: string | null;
  width: number | null;
  height: number | null;
  size: number;
  status: 'active' | 'flagged';
  createdAt: number;
}

export const MAX_BIO_LENGTH = 400;
export const MAX_LOCATION_LENGTH = 48;
export const MAX_NAME_LENGTH = 32;
export const MAX_INTERESTS = 10;
export const MAX_LANGUAGES = 5;

export function isComplete(profile: Profile | null | undefined): profile is Profile & { birthDate: string } {
  return Boolean(profile && profile.stage === 'complete' && profile.birthDate);
}

export function profileAge(profile: { birthDate: string | null }, now: number = Date.now()): number | null {
  return profile.birthDate ? ageOn(profile.birthDate, now) : null;
}

export function profileGroup(profile: { birthDate: string | null }, now: number = Date.now()): AgeGroup | null {
  const age = profileAge(profile, now);
  if (age === null) return null;
  const group = ageGroupOf(age);
  return group === 'child' ? null : group;
}

/**
 * Permanent URL of a stored photo. Discord signs unsigned CDN attachment URLs
 * automatically when they appear in components, so a photo uploaded once can
 * be shown in any number of messages without uploading it again.
 */
export function photoUrl(photo: Pick<Photo, 'channelId' | 'attachmentId' | 'filename'>): string {
  return `${CDN_BASE}/attachments/${photo.channelId}/${photo.attachmentId}/${encodeURIComponent(photo.filename)}`;
}
