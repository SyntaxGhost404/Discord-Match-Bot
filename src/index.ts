// Entry point: `npm start` (or `node src/index.ts`).

import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.ts';
import { BotRuntime, createApp } from './app.ts';
import { createLogger } from './util/logger.ts';

const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const log = createLogger(config.log);
const app = await createApp({ config, log });
const runtime = new BotRuntime(app);

let exiting = false;
const shutdown = async (code: number) => {
  if (exiting) return;
  exiting = true;
  const force = setTimeout(() => process.exit(code), 10_000);
  force.unref();
  try {
    await runtime.stop();
  } finally {
    process.exit(code);
  }
};

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('unhandledRejection', (error) => log.error('Unhandled promise rejection', { error }));
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception — shutting down', { error });
  void shutdown(1);
});

await runtime.start();
