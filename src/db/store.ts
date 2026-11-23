// One object that owns the database and all repositories.

import { Database } from './database.ts';
import { migrate } from './migrations.ts';
import { UsersRepo } from './repos/users.ts';
import { ProfilesRepo } from './repos/profiles.ts';
import { BlocksRepo, MatchesRepo, PhotosRepo, SwipesRepo } from './repos/social.ts';
import { ModActionsRepo, ReportsRepo } from './repos/moderation.ts';
import { ChatRepo } from './repos/chat.ts';
import { JobsRepo, KvRepo, RefsRepo } from './repos/jobs.ts';

export class Store {
  readonly db: Database;
  readonly users: UsersRepo;
  readonly profiles: ProfilesRepo;
  readonly photos: PhotosRepo;
  readonly swipes: SwipesRepo;
  readonly matches: MatchesRepo;
  readonly blocks: BlocksRepo;
  readonly reports: ReportsRepo;
  readonly modActions: ModActionsRepo;
  readonly chat: ChatRepo;
  readonly jobs: JobsRepo;
  readonly kv: KvRepo;
  readonly refs: RefsRepo;

  constructor(db: Database) {
    this.db = db;
    this.users = new UsersRepo(db);
    this.profiles = new ProfilesRepo(db);
    this.photos = new PhotosRepo(db);
    this.swipes = new SwipesRepo(db);
    this.matches = new MatchesRepo(db);
    this.blocks = new BlocksRepo(db);
    this.reports = new ReportsRepo(db);
    this.modActions = new ModActionsRepo(db);
    this.chat = new ChatRepo(db);
    this.jobs = new JobsRepo(db);
    this.kv = new KvRepo(db);
    this.refs = new RefsRepo(db);
  }

  static open(path: string): Store {
    const db = new Database(path);
    migrate(db);
    return new Store(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}
