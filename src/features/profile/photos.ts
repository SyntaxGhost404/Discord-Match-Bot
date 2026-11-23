import type { App } from '../../core/app.ts';
import type { PhotoProblem } from '../../services/photos.ts';
import { DM_HELP } from '../../ui/common.ts';

export function photoProblemText(problem: PhotoProblem, app: App): string {
  const mb = Math.round(app.config.media.maxPhotoBytes / (1024 * 1024));
  switch (problem) {
    case 'none':
      return 'No photos were uploaded.';
    case 'too_many':
      return `You can add up to ${app.config.media.maxPhotos} photos.`;
    case 'too_large':
      return `Each photo can be at most ${mb} MB. Try a smaller version.`;
    case 'not_image':
      return 'Only image files (JPG, PNG, WebP or GIF) can be used as photos.';
    case 'download_failed':
      return "I couldn't fetch your upload from Discord. Please try again.";
    case 'flagged':
      return "Discord's safety filter flagged one of those photos, so none were saved. Please choose different photos.";
    case 'no_storage':
      return `I couldn't store your photos because I can't DM you. ${DM_HELP}`;
    case 'upload_failed':
      return "Saving your photos failed on Discord's side. Please try again in a moment.";
  }
}
