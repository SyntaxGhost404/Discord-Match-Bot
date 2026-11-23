// Composition root: builds every service, registers features, routes gateway
// events and runs background work. Tests construct the same App with a fake
// Discord API, so what is tested is what runs.

import type { Config } from './config.ts';
import { ActivityType, GatewayIntents } from './discord/constants.ts';
import { RestClient } from './discord/rest/client.ts';
import { DiscordApi } from './discord/rest/api.ts';
import { GatewayManager } from './discord/gateway/manager.ts';
import { InteractionsServer } from './discord/http/server.ts';
import type { Interaction, Message, MessageDeleteEvent, MessageReactionEvent, PresenceUpdate, TypingStartEvent } from './discord/types.ts';
import { Router } from './interactions/router.ts';
import { Store } from './db/store.ts';
import { DirectMessenger } from './services/dm.ts';
import { JobRunner } from './services/jobs.ts';
import { PhotoService } from './services/photos.ts';
import type { App, AppInfo } from './core/app.ts';
import { syncCommands } from './core/commands.ts';
import { createGuard } from './core/guard.ts';
import { MatchingService } from './features/matching/service.ts';
import { ChatService } from './features/chat/service.ts';
import { RelayService } from './features/chat/relay.ts';
import { SafetyService } from './features/safety/service.ts';
import { AccountService } from './features/account/service.ts';
import { promptOnboarding, registerOnboarding } from './features/onboarding.ts';
import { registerMenu } from './features/menu.ts';
import { registerProfile } from './features/profile/handlers.ts';
import { registerMatching } from './features/matching/handlers.ts';
import { registerSafety } from './features/safety/handlers.ts';
import { registerChat } from './features/chat/handlers.ts';
import { registerSettings } from './features/settings.ts';
import { registerHelp } from './features/help.ts';
import { registerModeration } from './features/moderation.ts';
import { registerJobs } from './features/notifications.ts';
import { errorPayload, retryPayload, staleButtonPayload } from './ui/common.ts';
import { createLogger, type Logger } from './util/logger.ts';
import { DAY, MINUTE, SECOND, systemClock, type Clock } from './util/time.ts';

export interface CreateAppOptions {
  config: Config;
  api?: DiscordApi;
  store?: Store;
  clock?: Clock;
  log?: Logger;
  info?: AppInfo;
  fetch?: typeof fetch;
}

export async function fetchAppInfo(api: DiscordApi): Promise<AppInfo> {
  const application = await api.getCurrentApplication();
  const owners = new Set<string>();
  if (application.team) {
    for (const member of application.team.members) if (member.membership_state === 2) owners.add(member.user.id);
    owners.add(application.team.owner_user_id);
  } else if (application.owner) {
    owners.add(application.owner.id);
  }
  return { id: application.id, name: application.name, ownerIds: owners };
}

export async function createApp(options: CreateAppOptions): Promise<App> {
  const { config } = options;
  const log = options.log ?? createLogger(config.log);
  const api = options.api ?? new DiscordApi(new RestClient({ token: config.token, logger: log.child({ component: 'rest' }), fetch: options.fetch }), config.applicationId ?? '');
  const info = options.info ?? (await fetchAppInfo(api));
  api.applicationId = info.id;
  const store = options.store ?? Store.open(config.databasePath);
  const clock = options.clock ?? systemClock;
  const dm = new DirectMessenger(api, store, log);
  const jobs = new JobRunner(store, log, clock);
  const photos = new PhotoService({
    api,
    dm,
    store,
    log,
    storageChannelId: config.media.channelId,
    maxPhotos: config.media.maxPhotos,
    maxPhotoBytes: config.media.maxPhotoBytes,
    fetch: options.fetch,
  });

  // Features reach each other through `app`, so it is filled in step by step.
  const app = { config, log, api, store, dm, jobs, photos, clock, info, commandIds: new Map<string, string>(), fetch: options.fetch ?? fetch } as App;
  app.matching = new MatchingService(app);
  app.chat = new ChatService(app);
  app.relay = new RelayService(app);
  app.safety = new SafetyService(app);
  app.accounts = new AccountService(app);

  const guard = createGuard(app, (ctx) => promptOnboarding(app, ctx));
  app.router = new Router({
    services: { api, log, validatePayloads: config.validatePayloads },
    log,
    guard,
    unknown: (ctx) => ctx.reply(staleButtonPayload(), { ephemeral: true }),
    errorMessage: errorPayload,
    retryMessage: retryPayload,
  });
  app.pruneMemory = () => guard.limiter.prune(clock());

  registerOnboarding(app, app.router);
  registerMenu(app, app.router);
  registerProfile(app, app.router);
  registerMatching(app, app.router);
  registerSafety(app, app.router);
  registerChat(app, app.router);
  registerSettings(app, app.router);
  registerHelp(app, app.router);
  registerModeration(app, app.router);
  registerJobs(app);
  return app;
}

/** Routes one gateway dispatch event. Never throws. */
export function handleDispatch(app: App, event: string, data: unknown, shardId: number): void {
  const fail = (error: unknown) => app.log.error('Event handler failed', { event, error });
  try {
    switch (event) {
      case 'INTERACTION_CREATE':
        void app.router.handle(data as Interaction).catch(fail);
        break;
      case 'MESSAGE_CREATE':
        void app.relay.onMessageCreate(data as Message).catch(fail);
        break;
      case 'MESSAGE_UPDATE': {
        const message = data as Message;
        const flagged = app.photos.handleMessageUpdate(message);
        if (flagged.length) app.jobs.enqueue('notify.photos_flagged', { userId: flagged[0]!.userId, count: flagged.length });
        void app.relay.onMessageUpdate(message).catch(fail);
        break;
      }
      case 'MESSAGE_DELETE': {
        const deleted = data as MessageDeleteEvent;
        app.photos.handleMessageDelete(deleted.id);
        void app.relay.onMessageDelete(deleted).catch(fail);
        break;
      }
      case 'TYPING_START':
        void app.relay.onTyping(data as TypingStartEvent).catch(fail);
        break;
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE':
        void app.relay.onReaction(data as MessageReactionEvent, event === 'MESSAGE_REACTION_ADD').catch(fail);
        break;
      case 'READY':
        // A fresh session (not a resume) may have missed DMs while offline.
        if (shardId === 0) void app.relay.catchUp().catch(fail);
        break;
      default:
        break;
    }
  } catch (error) {
    fail(error);
  }
}

export function gatewayIntents(config: Config): number {
  let intents = GatewayIntents.DirectMessages | GatewayIntents.DirectMessageReactions | GatewayIntents.DirectMessageTyping;
  // Photo storage in a server channel: needed to see content-scan updates there.
  if (config.media.channelId) intents |= GatewayIntents.GuildMessages;
  return intents;
}

export const PRESENCE: PresenceUpdate = {
  since: null,
  status: 'online',
  afk: false,
  activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: 'Meet new people · /start' }],
};

/** Starts and stops everything that runs in the background. */
export class BotRuntime {
  private readonly app: App;
  private gateway: GatewayManager | null = null;
  private http: InteractionsServer | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private stopping = false;

  constructor(app: App) {
    this.app = app;
  }

  async start(): Promise<void> {
    const { app } = this;
    const { config, log } = app;
    try {
      app.commandIds = await syncCommands(app);
    } catch (error) {
      log.error('Command sync failed; continuing with existing commands', { error });
    }
    if (!config.moderation.channelId) log.warn('MOD_CHANNEL_ID is not set: reports are stored but not posted for moderators');
    if (!config.media.channelId) log.info("MEDIA_CHANNEL_ID is not set: profile photos are stored in each user's DM with the bot");

    app.jobs.start();
    this.every('chat sweep', 15 * SECOND, () => app.chat.sweep());
    this.every('maintenance', 10 * MINUTE, async () => {
      const now = app.clock();
      app.store.users.clearExpiredBans(now);
      app.store.chat.pruneRelays(now - 2 * DAY);
      app.store.jobs.pruneDead(now - 30 * DAY);
      app.pruneMemory();
    });

    if (config.interactions.mode === 'http') {
      this.http = new InteractionsServer({
        publicKey: config.publicKey!,
        host: config.interactions.host,
        port: config.interactions.port,
        path: config.interactions.path,
        logger: log,
        onInteraction: (interaction) => void app.router.handle(interaction),
      });
      await this.http.start();
    }

    this.gateway = new GatewayManager({
      api: app.api,
      token: config.token,
      intents: gatewayIntents(config),
      shardCount: config.shardCount,
      presence: PRESENCE,
      logger: log,
      onDispatch: (event, data, shardId) => handleDispatch(app, event, data, shardId),
      onFatal: (code, reason) => {
        log.error('Gateway connection failed permanently — check the token and intents', { code, reason });
        void this.stop().then(() => process.exit(1));
      },
    });
    await this.gateway.start();
    log.info('Bot is running', { app: app.info.name, mode: config.interactions.mode });
  }

  private every(name: string, ms: number, task: () => Promise<unknown> | unknown): void {
    let running = false;
    const timer = setInterval(async () => {
      if (running || this.stopping) return;
      running = true;
      try {
        await task();
      } catch (error) {
        this.app.log.error('Background task failed', { task: name, error });
      } finally {
        running = false;
      }
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.app.log.info('Shutting down…');
    for (const timer of this.timers) clearInterval(timer);
    this.app.jobs.stop();
    await this.http?.stop();
    this.gateway?.stop();
    await this.app.router.drain();
    this.app.store.close();
  }
}
