// Dispatches interactions to handlers.
//
//  * slash commands by name, components and modals by "<ns>:<action>"
//  * interactions of one user run strictly one after another (no double-click
//    races), while different users run in parallel
//  * a watchdog defers automatically shortly before Discord's 3-second
//    deadline, so slow paths never show "This interaction failed"
//  * guards (ban checks, onboarding gate…) run before every handler
//  * every failure ends in exactly one friendly error message

import { InteractionType } from '../discord/constants.ts';
import type { CommandInteraction, ComponentInteraction, Interaction, MessagePayload, ModalSubmitInteraction } from '../discord/types.ts';
import {
  InteractionContext,
  ModalUnavailableError,
  type AnyContext,
  type CommandContext,
  type ComponentContext,
  type ContextServices,
  type ModalContext,
} from './context.ts';
import { parseCustomId } from './custom-id.ts';
import { KeyedSerialQueue } from '../util/async.ts';
import type { Logger } from '../util/logger.ts';

/**
 * What a handler needs before it may run:
 *  none      – anyone (help pages)
 *  account   – not banned, account old enough (onboarding)
 *  profile   – all of the above plus a completed profile
 *  moderator – moderators only
 */
export type Gate = 'none' | 'account' | 'profile' | 'moderator';

export interface CommandHandler {
  name: string;
  gate: Gate;
  run(ctx: CommandContext): Promise<void>;
}

export interface ComponentHandler {
  ns: string;
  action: string;
  gate: Gate;
  run(ctx: ComponentContext, args: string[]): Promise<void>;
}

export interface ModalHandler {
  ns: string;
  action: string;
  gate: Gate;
  run(ctx: ModalContext, args: string[]): Promise<void>;
}

/** Returns false when the guard already answered and the handler must not run. */
export type Guard = (ctx: AnyContext, gate: Gate) => Promise<boolean>;

export interface RouterOptions {
  services: ContextServices;
  log: Logger;
  guard: Guard;
  /** Answer used for buttons from old messages / unknown commands. */
  unknown: (ctx: AnyContext) => Promise<void>;
  errorMessage: () => MessagePayload;
  /** Shown when a form could not open in time and the user should retry. */
  retryMessage: () => MessagePayload;
  watchdogMs?: number;
}

export class Router {
  private readonly commands = new Map<string, CommandHandler>();
  private readonly components = new Map<string, ComponentHandler>();
  private readonly modals = new Map<string, ModalHandler>();
  private readonly queue = new KeyedSerialQueue();
  private readonly options: RouterOptions;
  private readonly log: Logger;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: RouterOptions) {
    this.options = options;
    this.log = options.log.child({ component: 'router' });
  }

  command(handler: CommandHandler): this {
    if (this.commands.has(handler.name)) throw new Error(`Duplicate command handler ${handler.name}`);
    this.commands.set(handler.name, handler);
    return this;
  }

  component(handler: ComponentHandler): this {
    const key = `${handler.ns}:${handler.action}`;
    if (this.components.has(key)) throw new Error(`Duplicate component handler ${key}`);
    this.components.set(key, handler);
    return this;
  }

  modal(handler: ModalHandler): this {
    const key = `${handler.ns}:${handler.action}`;
    if (this.modals.has(key)) throw new Error(`Duplicate modal handler ${key}`);
    this.modals.set(key, handler);
    return this;
  }

  /** Entry point for INTERACTION_CREATE (gateway) and HTTP interactions. */
  handle(interaction: Interaction, receivedAt = Date.now()): Promise<void> {
    if (
      interaction.type !== InteractionType.ApplicationCommand &&
      interaction.type !== InteractionType.MessageComponent &&
      interaction.type !== InteractionType.ModalSubmit
    ) {
      return Promise.resolve();
    }
    let ctx: AnyContext;
    try {
      ctx = new InteractionContext(interaction, this.options.services, receivedAt);
    } catch (error) {
      this.log.warn('Dropping malformed interaction', { error });
      return Promise.resolve();
    }
    // The watchdog starts now, not when the user's queue reaches this task:
    // waiting behind the same user's slow interaction must not expire this one.
    const watchdogDelay = Math.max(0, (this.options.watchdogMs ?? 2300) - (Date.now() - receivedAt));
    const watchdog = setTimeout(() => {
      ctx.autoDefer().catch((error) => this.log.warn('Automatic defer failed', { error }));
    }, watchdogDelay);
    const task = this.queue.run(ctx.user.id, () => this.dispatch(ctx)).finally(() => clearTimeout(watchdog));
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return task;
  }

  /** Waits for running handlers (graceful shutdown). */
  async drain(timeoutMs = 5000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async dispatch(ctx: AnyContext): Promise<void> {
    const started = Date.now();
    const label = describe(ctx.interaction);
    try {
      await this.route(ctx);
    } catch (error) {
      await this.fail(ctx, error, label);
    } finally {
      const ms = Date.now() - started;
      if (ms > 2000) this.log.warn('Slow interaction handler', { interaction: label, ms });
      else this.log.debug('Handled interaction', { interaction: label, ms, user: ctx.user.id });
    }
  }

  private async route(ctx: AnyContext): Promise<void> {
    const interaction = ctx.interaction;
    if (interaction.type === InteractionType.ApplicationCommand) {
      const handler = this.commands.get(interaction.data.name);
      if (!handler) return this.options.unknown(ctx);
      if (!(await this.options.guard(ctx, handler.gate))) return;
      return handler.run(ctx as CommandContext);
    }

    const parsed = parseCustomId(interaction.data.custom_id);
    if (!parsed) return this.options.unknown(ctx);
    const key = `${parsed.ns}:${parsed.action}`;

    if (interaction.type === InteractionType.MessageComponent) {
      const handler = this.components.get(key);
      if (!handler) return this.options.unknown(ctx);
      if (!(await this.options.guard(ctx, handler.gate))) return;
      return handler.run(ctx as ComponentContext, parsed.args);
    }

    const handler = this.modals.get(key);
    if (!handler) return this.options.unknown(ctx);
    if (!(await this.options.guard(ctx, handler.gate))) return;
    return handler.run(ctx as ModalContext, parsed.args);
  }

  private async fail(ctx: AnyContext, error: unknown, label: string): Promise<void> {
    let message = this.options.errorMessage();
    if (error instanceof ModalUnavailableError) {
      // The watchdog had to acknowledge before the form could open.
      this.log.warn('Modal could not open because the interaction was already acknowledged', { interaction: label });
      message = this.options.retryMessage();
    } else {
      this.log.error('Interaction handler failed', { interaction: label, user: ctx.user.id, error });
    }
    try {
      await ctx.followUp(message, { ephemeral: true });
    } catch (secondary) {
      this.log.warn('Could not deliver the error message', { error: secondary });
    }
  }
}

function describe(interaction: CommandInteraction | ComponentInteraction | ModalSubmitInteraction): string {
  if (interaction.type === InteractionType.ApplicationCommand) return `/${interaction.data.name}`;
  if (interaction.type === InteractionType.MessageComponent) return `component ${interaction.data.custom_id}`;
  return `modal ${interaction.data.custom_id}`;
}
