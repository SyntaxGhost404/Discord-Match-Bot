// /profile — View or edit your profile.
// Shows the shared profile card (media showcase, headline, date of birth,
// interests) with two rows of edit buttons. Every edit goes through a modal
// prefilled from the current values; the card re-renders in place after each
// save. Photos are replaced through a File Upload modal (submitting it empty
// removes all photos).

import { db } from '../services/database.js';
import { matchmaking } from '../services/matchmaking.js';
import {
  profileCard, profileEditButtonRows, profileNameModal, profileDobModal,
  profileLocationModal, profileBioModal, profileInterestsModal,
  profileMediaModal, profileSavedCard, onboardRetryCard, simpleCard,
} from '../utils/embeds.js';
import {
  deferEphemeral, deferPublic, editOriginalClassic, editOriginalV2, interactionUser,
  openModal, parseModalSubmit, replyClassic, replyV2, safe,
} from '../discord/interactions.js';
import { Rest, V2 } from '../discord/rest.js';
import { downloadProfileMedia, clearProfileMedia } from '../utils/media.js';
import { EmbedFactory } from '../utils/embeds.js';
import { parseDOB, checkDOBAge, formatDOB } from '../utils/dob.js';
import { cleanText } from '../util.js';

export const data = {
  name: 'profile',
  description: 'View or edit your profile',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [
  'profile_edit_name',
  'profile_update_name_modal',
  'profile_edit_dob',
  'profile_update_dob_modal',
  'profile_edit_location',
  'profile_update_location_modal',
  'profile_edit_bio',
  'profile_update_bio_modal',
  'profile_edit_interests',
  'profile_update_interests_modal',
  'profile_edit_media',
  'profile_update_media_modal',
];

/**
 * Re-render the /profile card the modal was opened from, editing it in
 * place through the channel message endpoint. Modal submits cannot use the
 * UPDATE_MESSAGE / DEFERRED_UPDATE_MESSAGE callbacks (discord-llms-full.txt
 * marks those as valid for component interactions only), so the card is
 * patched directly. Returns true when the card was refreshed.
 */
async function patchProfileCardInPlace(interaction, user) {
  const profile = db.getUserProfile(user.id);
  const src = interaction.message;
  const channelId = src?.channel_id || interaction.channel_id;
  const { components, files } = profileCard(profile, { buttonRows: profileEditButtonRows() });
  const opts = files.length ? { files } : {};
  if (src?.id) {
    const res = await safe(Rest.editMessage(channelId, src.id, {
      flags: V2,
      components,
      attachments: files.map((f, i) => ({ id: String(i), filename: f.filename })),
    }, opts), 'profile card in-place edit');
    return res !== null;
  }
  // Practically unreachable: modals opened from components always carry
  // the source message. Fall back to the deferred response, ephemerally.
  const res = await safe(editOriginalV2(interaction, components, files), 'profile card fallback edit');
  return res !== null;
}

/**
 * Turn the ephemeral defer into a visible receipt of what changed. The
 * receipt is only a confirmation: the real update already landed on the
 * card via patchProfileCardInPlace.
 */
async function confirmProfileSave(interaction, saved, headline, detail) {
  const card = saved
    ? profileSavedCard(headline, detail)
    : profileSavedCard(
      'Something went wrong',
      'Your change was saved, but the profile card could not be refreshed. Run `/profile` again to see it.',
    );
  await safe(editOriginalV2(interaction, card), 'profile save confirmation');
}

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const profile = db.getUserProfile(user.id);

  if (!profile || !profile.is_onboarded) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('Set Up Your Profile', "You haven't set up your profile yet. Run any command to start the setup.")],
    });
  }

  // The card always renders in full. While searching or chatting the edit
  // buttons are greyed out (server-side guards still reject any stale-card
  // edit attempts outright).
  const locked = profileLockReason(user.id);

  await deferPublic(interaction);
  const { components, files } = profileCard(profile, { buttonRows: profileEditButtonRows(!!locked) });
  await safe(editOriginalV2(interaction, components, files, { ephemeral: false }), 'profile show');
}

/**
 * Profile edits are frozen while the user is searching the matchmaking queue
 * or paired in an active chat: a partner must never see a profile changing
 * mid-conversation, and queue eligibility must not shift under a live search.
 * Returns 'in_queue' | 'in_chat', or null when edits are allowed.
 */
function profileLockReason(userId) {
  if (db.getActiveSessionForUser(userId)) return 'in_chat';
  if (matchmaking.getQueuePosition(userId) != null) return 'in_queue';
  return null;
}

function profileLockedEmbed(reason) {
  const what = reason === 'in_chat' ? 'in an active chat' : 'searching for a chat';
  // /leave refuses during a live chat and redirects to /end, so naming
  // /leave to an in-chat user is a pointless round trip: name the command
  // that actually steps out of their current state.
  const remedy = reason === 'in_chat' ? '`/end`' : '`/leave`';
  return EmbedFactory.createInfoEmbed(
    'Profile Locked',
    `You can't change your profile while you're ${what}. Use ${remedy} to step out first, then run \`/profile\` again.`,
  );
}

export async function handleInteraction(interaction) {
  const customId = interaction.data?.custom_id;
  const user = interactionUser(interaction);
  const profile = db.getUserProfile(user.id);
  if (!profile) {
    // Stale edit button (no profile on record): answer with a short notice
    // instead of dropping the tap silently.
    return replyV2(interaction, simpleCard("👋 **No profile yet.**\n\nYou haven't set up your profile yet. Run any command to start the setup."));
  }

  // Every edit path (buttons and modal submits, including cards opened before
  // the user queued up) is frozen while searching or chatting.
  const lock = profileLockReason(user.id);
  if (lock) {
    return replyClassic(interaction, { embeds: [profileLockedEmbed(lock)] });
  }

  // ---- edit buttons -> modals -------------------------------------------
  if (customId === 'profile_edit_name') return openModal(interaction, profileNameModal(profile));
  if (customId === 'profile_edit_dob') return openModal(interaction, profileDobModal(profile));
  if (customId === 'profile_edit_location') return openModal(interaction, profileLocationModal(profile));
  if (customId === 'profile_edit_bio') return openModal(interaction, profileBioModal(profile));
  if (customId === 'profile_edit_interests') return openModal(interaction, profileInterestsModal(profile));
  if (customId === 'profile_edit_media') return openModal(interaction, profileMediaModal());

  // ---- modal submits -> save + re-render ---------------------------------
  if (customId === 'profile_update_name_modal') {
    const { fields } = parseModalSubmit(interaction);
    const name = cleanText(fields.profile_name_input || '').slice(0, 30);
    if (!name) {
      // Answered in the initial callback (no defer yet on this path).
      return replyV2(interaction, onboardRetryCard('Give yourself a name so we know what to call you.'));
    }
    await deferEphemeral(interaction);
    profile.name = name;
    db.updateUserProfile(profile);
    const nameSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(interaction, nameSaved, 'Name updated', `Your name is now **${name}**.`);
    return;
  }

  if (customId === 'profile_update_dob_modal') {
    const { fields } = parseModalSubmit(interaction);
    const dobRes = parseDOB(fields.profile_dob_day, fields.profile_dob_month, fields.profile_dob_year);
    if (!dobRes.ok) {
      return replyClassic(interaction, {
        embeds: [EmbedFactory.createErrorEmbed('Invalid Date of Birth', dobRes.error)],
      });
    }
    const ageRes = checkDOBAge(dobRes.dob);
    if (!ageRes.ok) {
      return replyClassic(interaction, {
        embeds: [EmbedFactory.createErrorEmbed('Invalid Date of Birth', ageRes.error)],
      });
    }
    await deferEphemeral(interaction);
    profile.dob = dobRes.dob;
    db.updateUserProfile(profile);
    const dobSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(
      interaction, dobSaved, 'Date of birth updated',
      `Now showing **${formatDOB(dobRes.dob)}** (age ${db.getUserAge(user.id)}).`,
    );
    return;
  }

  if (customId === 'profile_update_location_modal') {
    const { fields } = parseModalSubmit(interaction);
    await deferEphemeral(interaction);
    profile.location = cleanText(fields.profile_location_input || '').slice(0, 60);
    db.updateUserProfile(profile);
    const locSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(
      interaction, locSaved, 'Location updated',
      profile.location ? `Now showing **${profile.location}**.` : 'Your location was cleared.',
    );
    return;
  }

  if (customId === 'profile_update_bio_modal') {
    const { fields } = parseModalSubmit(interaction);
    await deferEphemeral(interaction);
    profile.bio = cleanText(fields.profile_bio_input || '').slice(0, 500);
    db.updateUserProfile(profile);
    const bioSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(
      interaction, bioSaved, 'Bio updated',
      profile.bio ? `Your bio now reads:\n> ${profile.bio}` : 'Your bio was cleared.',
    );
    return;
  }

  if (customId === 'profile_update_interests_modal') {
    const { fields } = parseModalSubmit(interaction);
    await deferEphemeral(interaction);
    profile.interests = String(fields.profile_interests_input || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 10);
    db.updateUserProfile(profile);
    const intSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(
      interaction, intSaved, 'Interests updated',
      profile.interests.length ? `Now showing **${profile.interests.join(', ')}**.` : 'All interests removed.',
    );
    return;
  }

  if (customId === 'profile_update_media_modal') {
    await deferEphemeral(interaction);
    const { fields, attachments, sizeLimit } = parseModalSubmit(interaction);
    const ids = fields.profile_media || [];
    if (!ids.length) {
      // Empty submit: remove every photo.
      profile.media = [];
      clearProfileMedia(user.id);
      db.updateUserProfile(profile);
      const cleared = await patchProfileCardInPlace(interaction, user);
      await confirmProfileSave(interaction, cleared, 'Photos updated', 'Removed all photos from your profile.');
      return;
    }
    const dl = await downloadProfileMedia(user.id, ids, attachments, sizeLimit);
    if (!dl.ok) {
      // Already deferred above, so replace the thinking message in place.
      return safe(editOriginalClassic(interaction, {
        embeds: [EmbedFactory.createErrorEmbed('Photos Not Saved', dl.error)],
      }), 'profile media error');
    }
    profile.media = dl.media;
    db.updateUserProfile(profile);
    const mediaSaved = await patchProfileCardInPlace(interaction, user);
    await confirmProfileSave(
      interaction, mediaSaved, 'Photos updated',
      dl.media.length === 1 ? 'Saved 1 photo to your profile.' : `Saved ${dl.media.length} photos to your profile.`,
    );
    return;
  }
}
