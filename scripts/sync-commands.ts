// Registers (or updates) the bot's slash commands without starting the bot.
//   npm run commands

import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { DiscordApi } from '../src/discord/rest/api.ts';
import { RestClient } from '../src/discord/rest/client.ts';
import { syncCommands } from '../src/core/commands.ts';
import { fetchAppInfo } from '../src/app.ts';
import { createLogger } from '../src/util/logger.ts';

const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const log = createLogger(config.log);
const api = new DiscordApi(new RestClient({ token: config.token, logger: log }));
const info = await fetchAppInfo(api);
api.applicationId = info.id;
const ids = await syncCommands({ api, config, log });
log.info('Commands registered', { commands: [...ids.keys()].join(', ') });
