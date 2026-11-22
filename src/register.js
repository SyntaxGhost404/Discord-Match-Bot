// Register (bulk-overwrite) the bot's slash commands via the raw REST API.
// Run standalone ONCE:  node src/register.js
// (index.js also calls registerCommands() on boot unless SKIP_REGISTER=1.)
//
// NEVER run this without real credentials in .env.

import { config } from './config.js';
import { Commands } from './discord/rest.js';
import { logger, setLogLevel } from './util.js';

import * as newCmd from './commands/new.js';
import * as leaveCmd from './commands/leave.js';
import * as endCmd from './commands/end.js';
import * as blockCmd from './commands/block.js';
import * as blocklistCmd from './commands/blocklist.js';
import * as unblockCmd from './commands/unblock.js';
import * as shareCmd from './commands/share.js';
import * as statsCmd from './commands/stats.js';
import * as reportCmd from './commands/report.js';
import * as profileCmd from './commands/profile.js';

const COMMANDS = [
  newCmd, leaveCmd, endCmd, blockCmd, blocklistCmd,
  unblockCmd, shareCmd, statsCmd, reportCmd, profileCmd,
].map((c) => c.data);

export async function registerCommands() {
  if (!config.token || !config.applicationId) {
    throw new Error('DISCORD_TOKEN and APPLICATION_ID must be set (see .env.example).');
  }
  if (config.guildId) {
    await Commands.overwriteGuild(config.guildId, COMMANDS);
    logger.info(`registered ${COMMANDS.length} guild command(s), live instantly`);
    return;
  }
  await Commands.overwriteGlobal(COMMANDS);
  logger.info(`registered ${COMMANDS.length} global command(s), can take up to ~1h to appear everywhere`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('register.js');
if (invokedDirectly) {
  setLogLevel(config.logLevel);
  registerCommands()
    .then(() => process.exit(0))
    .catch((err) => { logger.error('command registration failed:', err.message); process.exit(1); });
}
