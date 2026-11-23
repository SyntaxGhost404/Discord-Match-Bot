// The application container: everything a feature may use. Built once in
// src/app.ts; features receive it and reach collaborators through it, which
// keeps construction order simple and avoids circular imports.

import type { Config } from '../config.ts';
import type { DiscordApi } from '../discord/rest/api.ts';
import type { Store } from '../db/store.ts';
import type { Router } from '../interactions/router.ts';
import type { DirectMessenger } from '../services/dm.ts';
import type { JobRunner } from '../services/jobs.ts';
import type { PhotoService } from '../services/photos.ts';
import type { Logger } from '../util/logger.ts';
import type { Clock } from '../util/time.ts';
import type { MatchingService } from '../features/matching/service.ts';
import type { ChatService } from '../features/chat/service.ts';
import type { RelayService } from '../features/chat/relay.ts';
import type { SafetyService } from '../features/safety/service.ts';
import type { AccountService } from '../features/account/service.ts';

export interface AppInfo {
  id: string;
  name: string;
  /** Application owner / team members: always moderators. */
  ownerIds: ReadonlySet<string>;
}

export interface App {
  config: Config;
  log: Logger;
  api: DiscordApi;
  store: Store;
  dm: DirectMessenger;
  jobs: JobRunner;
  photos: PhotoService;
  clock: Clock;
  info: AppInfo;
  router: Router;
  matching: MatchingService;
  chat: ChatService;
  relay: RelayService;
  safety: SafetyService;
  accounts: AccountService;
  /** Registered command ids, for clickable </command:id> mentions. */
  commandIds: Map<string, string>;
  /** HTTP client for downloading attachments (injectable for tests). */
  fetch: typeof fetch;
  /** Drops expired entries from in-memory limiters. */
  pruneMemory: () => void;
}

/** "</discover:123>" when the id is known (clickable), otherwise "`/discover`". */
export function commandMention(app: Pick<App, 'commandIds'>, name: string): string {
  const id = app.commandIds.get(name.split(' ')[0]!);
  return id ? `</${name}:${id}>` : `\`/${name}\``;
}

export function brand(app: Pick<App, 'config' | 'info'>): string {
  return app.config.brandName ?? app.info.name;
}
