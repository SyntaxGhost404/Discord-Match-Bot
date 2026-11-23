// Profile forms (modals) and their parsing/validation, shared by onboarding
// and profile editing.

import {
  checkbox,
  checkboxGroup,
  choice,
  fileUpload,
  label,
  modal,
  option,
  radioGroup,
  stringSelect,
  text,
  textInput,
} from '../../discord/components/builders.ts';
import type { Modal } from '../../discord/types.ts';
import type { ModalValues } from '../../interactions/modal-values.ts';
import { GENDERS, INTERESTS, LANGUAGES, LOOKING_FOR, isGender, normalizeKeys, type Gender } from '../../domain/catalog.ts';
import { parseBirthDate } from '../../domain/age.ts';
import {
  MAX_BIO_LENGTH,
  MAX_INTERESTS,
  MAX_LANGUAGES,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  type Profile,
} from '../../domain/profile.ts';
import { checkDisplayName, checkFreeText, describeTextProblem, sanitizeLine, sanitizeMultiline } from '../../domain/text.ts';

// -- basics: name, birthday (onboarding only), gender, guidelines --------------------

export function basicsModal(customId: string, profile: Profile, options: { onboarding: boolean }): Modal {
  const birthday = profile.birthDate ? profile.birthDate.split('-').reverse().join('.') : undefined;
  return modal(customId, options.onboarding ? 'Create your profile · 1/2' : 'Edit your basics', [
    label('What should people call you?', textInput('name', { min: 2, max: MAX_NAME_LENGTH, required: true, value: profile.name, placeholder: 'A first name or nickname' })),
    options.onboarding &&
      label(
        'Your birthday',
        textInput('birthday', { min: 6, max: 20, required: true, value: birthday, placeholder: 'DD.MM.YYYY — e.g. 24.07.2006' }),
        'Only your age is shown. It keeps teens and adults apart and cannot be changed later.',
      ),
    label('Gender', radioGroup('gender', GENDERS.map((g) => choice(g.key, `${g.emoji} ${g.label}`, { selected: g.key === profile.gender })), { required: true })),
    options.onboarding &&
      label(
        'I agree to the community guidelines',
        checkbox('agree', profile.guidelinesAcceptedAt !== null),
        'Be kind · no harassment or explicit content · no lying about your age',
      ),
  ]);
}

export type BasicsResult =
  | { ok: true; name: string; gender: Gender; birthDate: string | null; agreed: boolean }
  | { ok: false; error: string; partial: { name?: string; gender?: Gender } };

export function parseBasics(values: ModalValues, options: { onboarding: boolean; now: Date }): BasicsResult {
  const name = sanitizeLine(values.text('name'), MAX_NAME_LENGTH);
  const genderRaw = values.radio('gender');
  const gender: Gender = isGender(genderRaw) ? genderRaw : 'unspecified';
  const nameProblem = checkDisplayName(name);
  const partial = { ...(nameProblem ? {} : { name }), gender };
  if (nameProblem) return { ok: false, error: describeTextProblem(nameProblem, 'name'), partial };
  if (!options.onboarding) return { ok: true, name, gender, birthDate: null, agreed: true };

  if (!values.checked('agree')) {
    return { ok: false, error: 'Please tick **"I agree to the community guidelines"** to continue. They keep this place friendly and safe.', partial };
  }
  const parsed = parseBirthDate(values.text('birthday'), options.now);
  if (!parsed.ok) {
    const error = {
      format: "I couldn't read that birthday. Please use day, month and year — for example **24.07.2006**.",
      invalid: "That date doesn't exist on the calendar. Please double-check the day and month.",
      future: "That birthday is in the future. Please enter your real date of birth.",
      too_old: 'That birthday looks off. Please enter your real date of birth.',
    }[parsed.reason];
    return { ok: false, error, partial };
  }
  return { ok: true, name, gender, birthDate: parsed.date, agreed: true };
}

// -- about: interests, looking for, languages, location, bio ---------------------------

export function aboutModal(customId: string, profile: Profile, title: string): Modal {
  const interests = new Set(profile.interests);
  const goals = new Set(profile.lookingFor);
  const languages = new Set(profile.languages);
  return modal(customId, title, [
    label(
      'Your interests',
      stringSelect(
        'interests',
        INTERESTS.map((i) => option(i.key, i.label, { emoji: i.emoji, selected: interests.has(i.key) })),
        { min: 1, max: MAX_INTERESTS, required: true, placeholder: `Pick up to ${MAX_INTERESTS}` },
      ),
      'People with shared interests are shown to you first',
    ),
    label(
      "What you're looking for",
      checkboxGroup(
        'looking_for',
        LOOKING_FOR.map((g) => choice(g.key, `${g.emoji} ${g.label}`, { selected: goals.has(g.key) })),
        { min: 1, max: LOOKING_FOR.length, required: true },
      ),
    ),
    label(
      'Languages you speak',
      stringSelect(
        'languages',
        LANGUAGES.map((l) => option(l.key, l.label, { emoji: l.emoji, selected: languages.has(l.key) })),
        { min: 1, max: MAX_LANGUAGES, required: true, placeholder: `Pick up to ${MAX_LANGUAGES}` },
      ),
    ),
    label('Where are you from? (optional)', textInput('location', { max: MAX_LOCATION_LENGTH, required: false, value: profile.location, placeholder: 'City, region or country' })),
    label(
      'About you (optional)',
      textInput('bio', { style: 'paragraph', max: MAX_BIO_LENGTH, required: false, value: profile.bio, placeholder: 'A few words about you, your hobbies, what you like to talk about…' }),
    ),
  ]);
}

export interface AboutValues {
  interests: string[];
  lookingFor: string[];
  languages: string[];
  location: string;
  bio: string;
}

export function parseAbout(values: ModalValues): { values: AboutValues; error: string | null } {
  const parsed: AboutValues = {
    interests: normalizeKeys(INTERESTS, values.values('interests'), MAX_INTERESTS),
    lookingFor: normalizeKeys(LOOKING_FOR, values.values('looking_for')),
    languages: normalizeKeys(LANGUAGES, values.values('languages'), MAX_LANGUAGES),
    location: sanitizeLine(values.text('location'), MAX_LOCATION_LENGTH),
    bio: sanitizeMultiline(values.text('bio'), MAX_BIO_LENGTH),
  };
  let error: string | null = null;
  if (!parsed.interests.length) error = 'Pick at least one interest.';
  else if (!parsed.lookingFor.length) error = "Pick at least one thing you're looking for.";
  else if (!parsed.languages.length) error = 'Pick at least one language you speak.';
  else {
    const locationProblem = checkFreeText(parsed.location);
    const bioProblem = checkFreeText(parsed.bio);
    if (locationProblem) error = describeTextProblem(locationProblem, 'location');
    else if (bioProblem) error = describeTextProblem(bioProblem, 'bio');
  }
  return { values: parsed, error };
}

// -- photos ------------------------------------------------------------------------------

export function photosModal(customId: string, options: { maxPhotos: number; hasPhotos: boolean; onboarding: boolean }): Modal {
  return modal(customId, options.onboarding ? 'Add your photos' : 'Update your photos', [
    text(
      options.hasPhotos
        ? `Upload up to **${options.maxPhotos}** photos to **replace** your current ones. Clear photos of you work best.`
        : `Upload up to **${options.maxPhotos}** photos. Clear photos of you work best.`,
    ),
    label(
      'Photos',
      fileUpload('photos', { min: options.hasPhotos ? 0 : 1, max: options.maxPhotos, required: !options.hasPhotos, fileTypes: ['image'] }),
      'JPG, PNG, WebP or GIF. No explicit content. Location data is removed.',
    ),
    options.hasPhotos && label('Remove all my photos instead', checkbox('remove_all'), 'Tick this and upload nothing to remove every photo'),
  ]);
}
