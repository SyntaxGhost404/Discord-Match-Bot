// Mandatory onboarding wizard. No slash command: the router intercepts every
// interaction (slash commands, buttons, modal submits) from users who have no
// profile record and diverts them here instead.
//
// The wizard runs across three modals with button hops between them (Discord
// only opens a modal from a command or a message-component interaction, never
// from a modal submit):
//   1. welcome card -> "onboard_start" button -> modal 1: name + date of
//      birth (Day/Month/Year, must yield age 13-99)
//   2. "onboard_next2" button -> modal 2: location + bio (both optional)
//   3. media prompt card -> "onboard_next3" button -> modal 3: photos/videos
//      via the File Upload component (1-6), or "Skip for now"
//   4. profile preview card -> "Looks good" confirms and creates the record,
//      "Start over" wipes the draft and begins again
//
// Progress lives in db.onboard_drafts, so abandoning halfway just shows a
// "Continue setup" welcome card next time (even across restarts). Nothing
// becomes a profile until the preview is confirmed.

import { db } from '../services/database.js';
import {
  onboardWelcomeCard, onboardRetryCard, onboardDoneCard, onboardTooYoungCard,
  onboardStep2Card, onboardMediaPromptCard, onboardPreviewIntro,
  onboardPreviewButtonRow, onboardModal1, onboardModal2, onboardModal3,
  profileCard, simpleCard,
} from '../utils/embeds.js';
import {
  deferEphemeral, deferUpdate, editOriginalV2, interactionUser,
  openModal, parseModalSubmit, replyV2, safe,
} from '../discord/interactions.js';
import { downloadProfileMedia, clearProfileMedia } from '../utils/media.js';
import { logger, cleanText } from '../util.js';
import { parseDOB, checkDOBAge } from '../utils/dob.js';

export const customIds = [
  'onboard_start',
  'onboard_m1',
  'onboard_next2',
  'onboard_m2',
  'onboard_next3',
  'onboard_skip_media',
  'onboard_m3',
  'onboard_confirm',
  'onboard_restart',
];

/** True when this user has no profile record and must onboard first. */
export function needsOnboarding(userId) {
  return !db.getUserProfile(userId);
}

/** Intercept: answer whatever they triggered with the welcome card instead. */
export async function startOnboarding(interaction) {
  const user = interactionUser(interaction);
  const draft = db.getOnboardDraft(user.id);
  await safe(replyV2(interaction, onboardWelcomeCard(!!draft)), 'onboarding welcome');
}

/** Fresh empty draft. */
function blankDraft() {
  return { step: 1, data: { name: '', dob: '', location: '', bio: '', media: [] } };
}

/**
 * Send the user to the wizard step their draft is on. Step 1 opens the
 * name/DOB modal, 2 the location/bio modal, 3 the media prompt, 4 the
 * profile preview.
 */
async function routeToStep(interaction, user) {
  if (!needsOnboarding(user.id)) {
    return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
  }
  const draft = db.getOnboardDraft(user.id) || blankDraft();
  const step = draft.step >= 1 && draft.step <= 4 ? draft.step : 1;
  if (step === 1) return openModal(interaction, onboardModal1(draft.data));
  if (step === 2) return openModal(interaction, onboardModal2(draft.data));
  if (step === 3) return replyV2(interaction, onboardMediaPromptCard());
  return showPreview(interaction, user, draft);
}

/** Render the preview step: intro line + profile card + confirm buttons. */
async function showPreview(interaction, user, draft, { deferred = false } = {}) {
  const previewProfile = {
    id: user.id,
    name: draft.data.name || 'Someone',
    dob: draft.data.dob,
    location: draft.data.location || '',
    bio: draft.data.bio || '',
    interests: [],
    media: draft.data.media || [],
  };
  const { components: [card], files } = profileCard(previewProfile, {
    buttonRows: [onboardPreviewButtonRow()],
  });
  const components = [...onboardPreviewIntro(), card];
  // Always defer + edit so the gallery files survive (a plain replyV2
  // cannot carry attachments). Callers that already deferred pass
  // { deferred: true } to avoid a second callback.
  if (!deferred) await deferUpdate(interaction);
  await safe(editOriginalV2(interaction, components, files), 'onboarding preview');
}

/** Validation failure: retry card whose button reopens the current step. */
async function retry(interaction, message) {
  await safe(replyV2(interaction, onboardRetryCard(message)), 'onboarding retry');
}

export async function handleInteraction(interaction) {
  const customId = interaction.data?.custom_id;
  const user = interactionUser(interaction);

  // ---- step 1: name + date of birth -------------------------------------
  if (customId === 'onboard_start') {
    return routeToStep(interaction, user);
  }

  if (customId === 'onboard_m1') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    const { fields } = parseModalSubmit(interaction);
    const name = cleanText(fields.onboard_name || '').slice(0, 30);
    if (!name) return retry(interaction, 'Give yourself a name so we know what to call you.');
    // Save the valid name now: if DOB validation fails below, the retry
    // modal reopens with the typed name still in place.
    const prevDraft = db.getOnboardDraft(user.id) || blankDraft();
    db.saveOnboardDraft(user.id, { step: 1, data: { ...prevDraft.data, name } });
    const dobRes = parseDOB(fields.onboard_dob_day, fields.onboard_dob_month, fields.onboard_dob_year);
    if (!dobRes.ok) return retry(interaction, dobRes.error);
    const ageRes = checkDOBAge(dobRes.dob);
    if (!ageRes.ok) {
      if (ageRes.tooYoung) {
        db.clearOnboardDraft(user.id);
        clearProfileMedia(user.id);
        logger.info(`rejected underage signup: ${user.id}`);
        return safe(replyV2(interaction, onboardTooYoungCard()), 'onboarding too young');
      }
      return retry(interaction, ageRes.error);
    }
    db.saveOnboardDraft(user.id, {
      step: 2,
      data: { ...(db.getOnboardDraft(user.id)?.data || {}), name, dob: dobRes.dob },
    });
    return safe(replyV2(interaction, onboardStep2Card(name)), 'onboarding step 2');
  }

  // ---- step 2: location + bio -------------------------------------------
  if (customId === 'onboard_next2') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    const draft = db.getOnboardDraft(user.id) || blankDraft();
    return openModal(interaction, onboardModal2(draft.data));
  }

  if (customId === 'onboard_m2') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    const { fields } = parseModalSubmit(interaction);
    const location = cleanText(fields.onboard_location || '').slice(0, 60);
    const bio = cleanText(fields.onboard_bio || '').slice(0, 500);
    const prev = db.getOnboardDraft(user.id) || blankDraft();
    db.saveOnboardDraft(user.id, { step: 3, data: { ...prev.data, location, bio } });
    return safe(replyV2(interaction, onboardMediaPromptCard()), 'onboarding media prompt');
  }

  // ---- step 3: photos/videos --------------------------------------------
  if (customId === 'onboard_next3') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    return openModal(interaction, onboardModal3());
  }

  if (customId === 'onboard_skip_media') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    const prev = db.getOnboardDraft(user.id) || blankDraft();
    if (Array.isArray(prev.data?.media) && prev.data.media.length) {
      // A stale "Skip for now" after a real upload: the draft media is being
      // discarded, so wipe the files too instead of orphaning them on disk.
      clearProfileMedia(user.id);
    }
    const draft = { step: 4, data: { ...prev.data, media: [] } };
    db.saveOnboardDraft(user.id, draft);
    return showPreview(interaction, user, draft);
  }

  if (customId === 'onboard_m3') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    await deferEphemeral(interaction);
    const { fields, attachments, sizeLimit } = parseModalSubmit(interaction);
    const dl = await downloadProfileMedia(user.id, fields.onboard_media, attachments, sizeLimit);
    if (!dl.ok) {
      return safe(
        editOriginalV2(interaction, onboardRetryCard(dl.error)),
        'onboarding media retry',
      );
    }
    const prev = db.getOnboardDraft(user.id) || blankDraft();
    const draft = { step: 4, data: { ...prev.data, media: dl.media } };
    db.saveOnboardDraft(user.id, draft);
    return showPreview(interaction, user, draft, { deferred: true });
  }

  // ---- step 4: preview confirm / restart ---------------------------------
  if (customId === 'onboard_confirm') {
    const draft = db.getOnboardDraft(user.id);
    if (!needsOnboarding(user.id) || !draft?.data?.name || !draft?.data?.dob) {
      // Broken draft: wipe it and send the user back to a fresh welcome
      // card instead of a retry card that loops to this same failure.
      db.clearOnboardDraft(user.id);
      return startOnboarding(interaction);
    }
    await deferUpdate(interaction);
    const profile = db.createProfile({
      id: user.id,
      name: draft.data.name,
      dob: draft.data.dob,
      location: draft.data.location || '',
      bio: draft.data.bio || '',
      media: draft.data.media || [],
    });
    db.clearOnboardDraft(user.id);
    logger.info(`onboarded ${user.id} (${profile.name})`);
    // Omit attachments: the preview media is removed from this message.
    await safe(editOriginalV2(interaction, onboardDoneCard(profile.name)), 'onboarding done');
    return;
  }

  if (customId === 'onboard_restart') {
    if (!needsOnboarding(user.id)) {
      return replyV2(interaction, simpleCard('You are already set up. Use `/new` to find someone to chat with.'));
    }
    db.clearOnboardDraft(user.id);
    clearProfileMedia(user.id);
    return openModal(interaction, onboardModal1());
  }
}
