// Entry point: raw Discord anonymous-chat bot.
//
//  1. loads config + database
//  2. registers slash commands (raw REST, skipped with SKIP_REGISTER=1)
//  3. connects to the Gateway (raw WebSocket) and routes INTERACTION_CREATE
//     to the router and MESSAGE_CREATE to the chat relay.
//
// No discord.js / eris / oceanic. Every Discord API call is handcrafted.

import { config } from './config.js';
import { db } from './services/database.js';
import { setLogLevel, logger } from './util.js';
import { Gateway } from './discord/gateway.js';
import { routeInteraction } from './router.js';
import { handleDirectMessage, sweepMatchmaking, sweepIdleSessions } from './services/chat.js';
import { registerCommands } from './register.js';

setLogLevel(config.logLevel);
logger.info('anon-chat-remake starting…');

db.load();

if (process.env.SKIP_REGISTER === '1') {
  logger.info('SKIP_REGISTER=1: skipping command registration');
} else {
  try {
    await registerCommands();
  } catch (err) {
    logger.error('command registration failed (continuing anyway):', err.message);
  }
}

const gateway = new Gateway(async (event, data) => {
  if (event === 'INTERACTION_CREATE') {
    await routeInteraction(data);
  } else if (event === 'MESSAGE_CREATE') {
    await handleDirectMessage(data);
  }
  // Other dispatches (READY etc.) are handled inside the gateway itself.
});

async function shutdown(signal) {
  logger.info(`received ${signal}, shutting down…`);
  await gateway.stop();
  await db.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection:', err);
});

// The debounced save() can leave dirty state in memory; on a crash we make
// a last attempt to persist it before the process dies.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception:', err);
  try {
    db.flush();
  } catch (flushErr) {
    logger.error('flush on crash failed:', flushErr.message);
  }
  process.exit(1);
});

// Every 30s, pair up eligible waiters so age-gap expansion resolves for
// long waiters without needing a fresh /new to trigger a match attempt.
// The same tick wraps up sessions that went quiet for 30 minutes: both
// strangers get the timeout summary card.
setInterval(() => {
  sweepMatchmaking().catch((err) => logger.error('matchmaking sweep failed:', err));
  sweepIdleSessions().catch((err) => logger.error('idle sweep failed:', err));
}, 30_000);

await gateway.start();
