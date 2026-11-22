# anon-chat-remake

A faithful remake of the reference anonymous-chat Discord bot, rebuilt from the
ground up on **raw Discord REST API + raw Gateway WebSocket** calls. Zero
dependencies: only `fetch()`, `WebSocket`, and Node built-ins. No discord.js,
eris, oceanic, or any wrapper.

## What it is

Two strangers type `/new`, get matched, and chat anonymously through the bot's
DMs. Either can leave, block, report, or share their username. The reference
implementation's flow, gates, copy, colors, and limits are kept verbatim; the
interactive cards (searching, matched, share confirm) are modernized as
Components V2 Containers.

## Reference-file → remake-file map

The reference was a discord.js command set; this remake mirrors its structure:

| Reference | Remake |
|---|---|
| `commands/new.js` | `src/commands/new.js` |
| `commands/leave.js` | `src/commands/leave.js` |
| `commands/end.js` | `src/commands/end.js` |
| `commands/block.js` | `src/commands/block.js` |
| `commands/blocklist.js` | `src/commands/blocklist.js` |
| `commands/unblock.js` | `src/commands/unblock.js` |
| `commands/share.js` | `src/commands/share.js` |
| `commands/stats.js` | `src/commands/stats.js` |
| `commands/report.js` | `src/commands/report.js` |
| `commands/profile.js` | `src/commands/profile.js` |
| `utils/embeds.js` (EmbedFactory) | `src/utils/embeds.js` (+ V2 card builders) |
| `utils/database.js` (Supabase) | `src/services/database.js` (local JSON store) |
| `utils/safety.js` | `src/services/safety.js` |
| `services/matchmaking.js` | `src/services/matchmaking.js` |
| `services/chat.js` | `src/services/chat.js` |
| discord.js client/intents | `src/discord/gateway.js` (raw WebSocket) |
| discord.js REST/interactions | `src/discord/rest.js`, `src/discord/interactions.js` |
| (new) | `src/router.js` (interaction dispatch) |
| (new) | `src/index.js` (entry point) |
| (new) | `src/register.js` (bulk-overwrite commands) |

## Quick start (you only)

```bash
cp .env.example .env        # fill in DISCORD_TOKEN and APPLICATION_ID
node src/register.js        # register the 10 slash commands ONCE
node src/index.js           # connect to the gateway and run
```

Set `SKIP_REGISTER=1` on subsequent boots to skip re-registration.
Use `GUILD_ID` in `.env` for instant guild-scoped registration while testing.

## Documented deviations from the reference

- **Mandatory onboarding, no `/onboard` command.** The router intercepts every
  interaction (slash command, button, modal submit) from a user with no profile
  record and diverts them into `src/flows/onboarding.js`: one welcome card ->
  one "Get started" button -> one modal (nickname, age 13-99, optional
  interests). Profiles are created only there, never auto-created. The `/new`
  gate copy mentioning `/onboard` is now unreachable but stays verbatim.
- **Block-aware matching.** Blocked pairs are never matched (the reference
  could rematch them).
- **V2-wrapped cards.** The searching, matched, and share-confirm cards are
  single Components V2 Containers; classic embeds are kept where the reference
  used them (`/stats`, `/blocklist`, share notify, success/error).
- **`unblock_select` handled.** The reference built this menu without a
  handler; here it unblocks and refreshes the list.
- **Chat relay** uses V2 containers with `allowed_mentions.parse: []`,
  8 msgs / 20 s rate limit, 10-file / 20 MB caps, photos in media galleries.

## Tests

`npm test` (or `node tests/remake.mjs`): mocked-fetch suite covering every
command, the DM relay, share caps/cooldown, block-list flows, report modal,
profile edits, chat-card buttons, the router, and the mandatory onboarding
flow. 136 assertions, all green.
