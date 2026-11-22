// Runtime configuration, read from the environment.
// Copy .env.example to .env and fill in DISCORD_TOKEN + APPLICATION_ID.

import path from 'node:path';

export const config = {
  token: process.env.DISCORD_TOKEN || '',
  applicationId: process.env.APPLICATION_ID || '',
  guildId: process.env.GUILD_ID || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  gatewayVersion: 10,
};

export const paths = {
  dataDir: config.dataDir,
  dbFile: path.join(config.dataDir, 'db.json'),
  // Profile media (photos/videos uploaded during onboarding or /profile
  // edits) lives here: <mediaDir>/<discordUserId>/<attachmentId>_<filename>.
  // Files are re-attached to messages when a profile card is rendered, so
  // nothing depends on expiring CDN URLs.
  mediaDir: path.join(config.dataDir, 'media'),
};
