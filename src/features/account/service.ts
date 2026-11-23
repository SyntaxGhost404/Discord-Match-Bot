// Account lifecycle: full data deletion on request.
//
// Deleted: profile, photos (including the stored image messages), likes,
// matches and the user's own block list. Kept on purpose: bans and blocks
// *against* the user (so deleting an account can't be used to dodge either),
// and reports (moderation history).

import type { App } from '../../core/app.ts';

export class AccountService {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  async delete(userId: string): Promise<void> {
    const { store } = this.app;
    store.chat.dequeue(userId);
    await this.app.chat.endForUser(userId, 'deleted');
    const photos = store.transaction(() => {
      const removed = store.photos.removeAll(userId);
      store.swipes.deleteAllBy(userId);
      store.matches.deleteAllFor(userId);
      store.blocks.deleteMadeBy(userId);
      store.profiles.delete(userId);
      return removed;
    });
    await this.app.photos.discard(photos);
    this.app.log.info('Account data deleted', { userId, photos: photos.length });
  }
}
