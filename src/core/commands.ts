// Application command definitions and a diff-based sync: commands are only
// overwritten when they actually changed (Discord limits command creates to
// 200 per day), and their ids are kept for clickable command mentions.

import { ApplicationCommandOptionType as Opt, ApplicationIntegrationType, InteractionContextType } from '../discord/constants.ts';
import type { CommandDefinition, CommandOptionDefinition, RegisteredCommand } from '../discord/types.ts';
import type { App } from './app.ts';

const EVERYWHERE = {
  integration_types: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDm, InteractionContextType.PrivateChannel],
};

const slash = (name: string, description: string, options?: CommandOptionDefinition[]): CommandDefinition => ({
  name,
  type: 1,
  description,
  ...(options ? { options } : {}),
  ...EVERYWHERE,
});

export function globalCommands(): CommandDefinition[] {
  return [
    slash('start', 'Open the main menu (or create your profile)'),
    slash('discover', 'Browse people and like the ones you want to meet'),
    slash('likes', 'See who liked your profile'),
    slash('matches', 'Your mutual matches'),
    slash('profile', 'View and edit your profile'),
    slash('chat', 'Talk anonymously with a random person'),
    slash('next', 'Skip to a new anonymous chat partner'),
    slash('stop', 'End your anonymous chat or stop searching'),
    slash('settings', 'Discovery filters, notifications, privacy and your data'),
    slash('help', 'How everything works, plus safety tips'),
  ];
}

const userTarget: CommandOptionDefinition[] = [
  { type: Opt.User, name: 'user', description: 'The user (if they are in this server)' },
  { type: Opt.String, name: 'id', description: 'Or their Discord user id', min_length: 15, max_length: 21 },
];

export function moderatorCommands(): CommandDefinition[] {
  return [
    {
      name: 'mod',
      type: 1,
      description: 'Moderation tools',
      default_member_permissions: '4', // BAN_MEMBERS
      options: [
        { type: Opt.SubCommand, name: 'user', description: 'Look up a user: profile, reports and history', options: userTarget },
        {
          type: Opt.SubCommand,
          name: 'ban',
          description: 'Suspend a user from the bot',
          options: [
            { type: Opt.String, name: 'reason', description: 'Why (shown to the user)', required: true, max_length: 300 },
            {
              type: Opt.String,
              name: 'duration',
              description: 'How long',
              required: true,
              choices: [
                { name: '1 day', value: '1d' },
                { name: '7 days', value: '7d' },
                { name: '30 days', value: '30d' },
                { name: 'Permanent', value: 'permanent' },
              ],
            },
            ...userTarget,
          ],
        },
        { type: Opt.SubCommand, name: 'unban', description: 'Lift a suspension', options: userTarget },
        { type: Opt.SubCommand, name: 'reports', description: 'Open reports waiting for review' },
        { type: Opt.SubCommand, name: 'stats', description: 'Usage statistics' },
      ],
    },
  ];
}

// -- sync ----------------------------------------------------------------------

type Comparable = Record<string, unknown>;

function normalizeOption(option: CommandOptionDefinition): Comparable {
  return {
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    choices: option.choices?.map((c) => ({ name: c.name, value: c.value })) ?? null,
    options: option.options?.map(normalizeOption) ?? null,
    min_length: option.min_length ?? null,
    max_length: option.max_length ?? null,
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    autocomplete: option.autocomplete ?? false,
  };
}

export function normalizeCommand(command: CommandDefinition): Comparable {
  return {
    name: command.name,
    type: command.type ?? 1,
    description: command.description,
    options: (command.options ?? []).map(normalizeOption),
    default_member_permissions: command.default_member_permissions ?? null,
    nsfw: command.nsfw ?? false,
    contexts: command.contexts ? [...command.contexts].sort() : null,
    integration_types: command.integration_types ? [...command.integration_types].sort() : null,
  };
}

export function commandsDiffer(desired: CommandDefinition[], existing: RegisteredCommand[], scope: 'global' | 'guild'): boolean {
  const clean = (c: CommandDefinition) => {
    const n = normalizeCommand(c);
    // Guild commands report no installation/interaction contexts.
    if (scope === 'guild') {
      n.contexts = null;
      n.integration_types = null;
    }
    return JSON.stringify(n);
  };
  const a = desired.map(clean).sort();
  const b = existing.map((c) => clean(c)).sort();
  return a.length !== b.length || a.some((value, i) => value !== b[i]);
}

/** Syncs commands and returns name → id. */
export async function syncCommands(app: Pick<App, 'api' | 'config' | 'log'>): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const { sync, devGuildId } = app.config.commands;
  const log = app.log.child({ component: 'commands' });
  const desired = globalCommands();

  if (sync === 'off') {
    try {
      for (const c of await app.api.getGlobalCommands()) ids.set(c.name, c.id);
    } catch (error) {
      log.warn('Could not read registered commands', { error });
    }
  } else if (sync === 'guild' && devGuildId) {
    // Guild commands are instant (handy while developing) but don't work in DMs.
    const guildDesired = [
      ...desired.map(({ integration_types: _i, contexts: _c, ...rest }) => rest),
      ...(devGuildId === app.config.moderation.guildId ? moderatorCommands() : []),
    ];
    const existing = await app.api.getGuildCommands(devGuildId);
    const registered = commandsDiffer(guildDesired, existing, 'guild') ? await app.api.bulkOverwriteGuildCommands(devGuildId, guildDesired) : existing;
    for (const c of registered) ids.set(c.name, c.id);
    log.info('Guild commands ready', { guild: devGuildId, count: registered.length });
  } else {
    const existing = await app.api.getGlobalCommands();
    const registered = commandsDiffer(desired, existing, 'global') ? await app.api.bulkOverwriteGlobalCommands(desired) : existing;
    if (registered !== existing) log.info('Global commands updated', { count: registered.length });
    for (const c of registered) ids.set(c.name, c.id);
  }

  const modGuild = app.config.moderation.guildId;
  if (modGuild && !(sync === 'guild' && devGuildId === modGuild)) {
    try {
      const desiredMod = moderatorCommands();
      const existing = await app.api.getGuildCommands(modGuild);
      const registered = commandsDiffer(desiredMod, existing, 'guild') ? await app.api.bulkOverwriteGuildCommands(modGuild, desiredMod) : existing;
      for (const c of registered) ids.set(c.name, c.id);
    } catch (error) {
      log.warn('Could not register moderator commands (is the bot in MOD_GUILD_ID?)', { error });
    }
  }
  return ids;
}
