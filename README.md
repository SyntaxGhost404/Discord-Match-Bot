# Discord Match Bot

A Discord bot for **meeting new people** — friends, gaming buddies, study partners or just someone to talk to. Inspired by Telegram's social matching bots, rebuilt for Discord. It is a *match* bot, not a dating bot.

Everything talks to the **raw Discord API** (REST + Gateway, API v10) — no discord.js, eris or any other wrapper — so new platform features are usable the day they ship. It is written in TypeScript and runs directly on Node.js with a single small runtime dependency.

---

## What it does

| | |
|---|---|
| **🔍 Discover** | Browse profiles one at a time: photos, age, location, languages, interests, what they're looking for — shared interests highlighted. **Like**, **like with a note**, **skip** or **report**. |
| **💌 Likes** | People who liked you, one card at a time, with their note. Like back to match. Batched DM alerts ("You have 3 new likes"). |
| **🤝 Matches** | Mutual likes reveal each other's Discord account (mention + profile link). Paginated list, unmatch, report. |
| **🎲 Anonymous chat** | Random pairing with a compatible person; messages relay through the bot's DMs with no names. Replies, edits, deletions, reactions and typing indicators are mirrored. Photos, video, audio and native voice messages relay too (text-only for teens). Icebreakers, and **Reveal profiles** when *both* agree. Chats survive restarts, and messages sent while the bot was offline are relayed on reconnect. |
| **👤 Profile** | Guided onboarding (two forms + optional photos + review). Edit everything except the birthday, pause discovery, see private stats. |
| **⚙️ Settings** | Age range, who to show, language matching, like alerts, chat profanity filter, blocked people, full data deletion. |
| **🛡️ Moderation** | Reports land in a moderator channel with the chat transcript attached and **Ban / Hide / Dismiss** buttons. `/mod user`, `/mod ban`, `/mod unban`, `/mod reports`, `/mod stats`. |

Commands: `/start` `/discover` `/likes` `/matches` `/profile` `/chat` `/next` `/stop` `/settings` `/help` (+ `/mod` in the moderator server). They work in servers, in the bot's DMs, and — as a user-installed app — anywhere.

## Safety & privacy by design

- **Age wall.** Teens (13–17) and adults are never shown to or paired with each other. Teens only meet teens born **at most two years apart** (calendar-exact), and that window can't be widened. Ages are computed live from the birth date, so birthdays move people between groups automatically. Under-13 sign-ups are refused and gated until their 13th birthday.
- **Birthday is immutable** after a confirmation step ("you're 17 — is that right?"), so nobody can hop between age groups.
- **No identity leaks before a match.** Discord user ids never appear in buttons or select menus before people match — components carry opaque reference numbers. Anonymous-chat partners stay anonymous everywhere, including your block list.
- **Photos:** type checked by magic bytes, **EXIF/GPS and other metadata stripped** (JPEG/PNG/WebP) before upload, and Discord's content-scanning flags (explicit / gore / self-harm) are checked on upload and on every later update — flagged photos are removed automatically.
- **Chats:** profanity masked for recipients who want it (always for teens), links removed in teen chats, link previews suppressed, unsafe media blocked, per-user message rate limits, no pings (`allowed_mentions` is empty on everything).
- **Reports** include evidence, auto-hide a profile after 3 distinct reporters in 7 days pending review, and bans end chats, leave queues and resolve open reports. Every moderator action is logged.
- **Your data:** `/settings → Delete my data` removes profile, photos (including the stored image messages), likes and matches. Bans and blocks *against* a user survive deletion on purpose.
- Optional minimum Discord account age (`MIN_ACCOUNT_AGE_DAYS`).

## Architecture

```
src/
├─ discord/           raw Discord API layer (no wrappers)
│  ├─ rest/           HTTP client: bucket rate limits (X-RateLimit-Bucket + major param),
│  │                  global 50 req/s window, 429 retry_after, safe retries, multipart uploads
│  ├─ gateway/        shard state machine (HELLO → heartbeat → IDENTIFY/RESUME, zombie
│  │                  detection, RECONNECT / INVALID_SESSION, fatal close codes) + manager
│  │                  with identify throttling (max_concurrency buckets, daily budget guard)
│  ├─ http/           optional HTTP interactions endpoint with Ed25519 verification
│  ├─ components/     typed builders (Components V2, classic rows, modal Label / Radio Group /
│  │                  Checkbox Group / Checkbox / File Upload) + a validator for every
│  │                  documented limit
│  ├─ constants.ts    enums transcribed from the docs
│  └─ types.ts        wire-format types
├─ interactions/      InteractionContext (acknowledgement state machine), router
│                     (per-user ordering, 3-second watchdog, guards), custom_id codec
├─ db/                node:sqlite wrapper, migrations, repositories
├─ domain/            pure logic: age rules, compatibility, catalogs, text hygiene
├─ services/          DM delivery, durable job queue, photo pipeline, image metadata stripping
├─ features/          onboarding, menu, profile, matching (discover/likes/matches),
│                     chat (queue/sessions/relay), safety, settings, help, moderation,
│                     notifications
├─ core/              app container, guard, command definitions + diff-based sync
├─ ui/                theme, shared cards, the profile card
├─ app.ts             composition root, gateway event routing, background tasks
└─ index.ts           entry point
```

**Why it doesn't break:**

- **Atomic state.** SQLite calls are synchronous, so each state change (a like *and* its notification, a pairing *and* the queue removal, a ban *and* everything it affects) is one transaction that nothing can interleave with. Network I/O happens only after commit. The database enforces invariants too — e.g. one live chat per person is a primary key.
- **Transactional outbox.** Notifications and moderator posts are jobs written in the same transaction as the change that caused them, delivered with retries and backoff, surviving restarts.
- **Acknowledgement state machine.** Handlers say *reply / update / show modal / defer*; the context picks the right endpoint for the interaction's current state, so double acknowledgement is impossible. A watchdog defers automatically before the 3-second deadline, even when an interaction waits behind the same user's previous one.
- **Per-user ordering** for interactions and **per-channel ordering** for relayed messages; double clicks are harmless.
- **Stale buttons are safe.** Every button re-validates state server-side; buttons from old messages (including the legacy bot) get a friendly answer.
- **Fail-fast configuration** listing every problem at startup; tokens are redacted from all logs.

**Components V2 and classic, each where it fits:** profile cards, menus, discovery, chats and settings are Components V2 (media galleries, sections with button accessories, containers with accent colors). Data-dense receipts — the end-of-chat summary and moderator report/user cards — are classic embeds with fields and buttons. Quick notices use small embeds. Relayed chat messages are plain native messages so they look like a real conversation, while every system notice is a card, so a partner can't impersonate the bot.

**Photos are uploaded once.** Discord automatically signs unsigned CDN attachment URLs used in components (verified against the live API), so a photo stored once is shown in any number of cards without re-uploading.

## Setup

**Requirements:** Node.js **22.18+** (runs TypeScript natively; Node 24 LTS recommended). No build step, no native modules.

1. **Developer Portal** → your application:
   - *Installation*: enable **Guild Install** and **User Install** (scope `applications.commands`; add `bot` to Guild Install).
   - *Bot*: no privileged intents are needed (DM content is available to bots without the Message Content intent).
2. Install and configure:
   ```bash
   npm install
   cp .env.example .env     # then fill in DISCORD_TOKEN (and the recommended values)
   ```
3. Run:
   ```bash
   npm start                # syncs slash commands, connects to the gateway
   ```

**Recommended configuration** (see `.env.example` for everything):

| Variable | Why |
|---|---|
| `MOD_GUILD_ID`, `MOD_CHANNEL_ID` | Where `/mod` lives and where reports are posted. |
| `MEDIA_CHANNEL_ID` | A **private** channel only the bot can see, for photo storage. Without it photos live in each user's DM with the bot (works, but needs DMs). |
| `SUPPORT_SERVER_URL` | **Discord bots can only DM people who share a server with them** (error 50278) — user-installing the app isn't enough. Notifications and anonymous chat happen in DMs, so give people a server to join; the bot offers this link whenever DMs fail. |

Other modes:

- `INTERACTIONS_MODE=http` + `DISCORD_PUBLIC_KEY` serves an Interactions Endpoint (Ed25519-verified) at `HTTP_PATH`; set that URL in the Developer Portal. The gateway is still used for DMs.
- `COMMANDS_SYNC=guild` + `DEV_GUILD_ID` registers commands to one server for instant updates while developing; `off` leaves commands untouched. Sync only writes when definitions changed.
- `npm run commands` registers commands without starting the bot.

**Running in production:** use a process manager (systemd, pm2, Docker…) with automatic restarts. `SIGINT`/`SIGTERM` shut down gracefully. Back up the SQLite file in `DATABASE_PATH` (WAL mode; copy with `sqlite3 bot.db ".backup backup.db"` or while stopped). Run a single instance per token — two instances would both answer every interaction.

## Testing

```bash
npm run check            # type-check + all tests
npm test                 # tests only
```

The suite (47 tests) covers the domain rules, the REST client and rate limiter, the gateway state machine, signature verification, metadata stripping, the HTTP endpoint, the watchdog, and **end-to-end flows** through the real application with a fake Discord that validates every payload against the documented limits: onboarding, likes → matches, the age wall, anonymous chat relay (replies, edits, deletes, reactions, typing, offline catch-up), reveals, reports with evidence, bans, settings, data deletion and failure unwinding.

`npm run live-check` (with `LIVE_CHECK_CHANNEL_ID`) renders every card with sample data, posts each to a test channel so **Discord's own validator** accepts it, checks photos render via unsigned CDN URLs, and deletes everything afterwards.

## Migrating from the previous bot

The old implementation (anonymous chat on raw REST/Gateway with a JSON file database) stays untouched on `main`. This version is a clean rewrite with a different data model, so old data isn't imported; users simply create a new profile. Starting the new bot replaces the old global slash commands; buttons on old messages are answered with a pointer to `/start`.
