// Optional HTTP interactions endpoint. When an Interactions Endpoint URL is
// configured in the Developer Portal, Discord POSTs interactions here instead
// of sending INTERACTION_CREATE over the gateway (the two are exclusive).
//
// Every request is signature-verified. PINGs are answered inline; all other
// interactions are acknowledged with 202 and handed to the same router the
// gateway uses, which answers through the REST callback endpoint (documented
// behaviour: "respond to the original HTTP request with a 202 and no body").

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { KeyObject } from 'node:crypto';
import { InteractionType } from '../constants.ts';
import type { Interaction } from '../types.ts';
import { publicKeyFromHex, verifyInteractionSignature } from './verify.ts';
import type { Logger } from '../../util/logger.ts';

const MAX_BODY_BYTES = 1_000_000;

export interface InteractionsServerOptions {
  publicKey: string;
  host: string;
  port: number;
  path: string;
  logger: Logger;
  onInteraction: (interaction: Interaction) => void;
}

export class InteractionsServer {
  private readonly options: InteractionsServerOptions;
  private readonly key: KeyObject;
  private readonly log: Logger;
  private server: Server | null = null;

  constructor(options: InteractionsServerOptions) {
    this.options = options;
    this.key = publicKeyFromHex(options.publicKey);
    this.log = options.logger.child({ component: 'http' });
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log.error('HTTP interaction handling failed', { error });
        if (!res.headersSent) respond(res, 500, { error: 'internal error' });
      });
    });
    this.server.requestTimeout = 10_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, () => {
        this.log.info('Interactions endpoint listening', { host: this.options.host, port: this.options.port, path: this.options.path });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return respond(res, 200, { ok: true });
    if (url.pathname !== this.options.path) return respond(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'method not allowed' });

    const body = await readBody(req);
    if (!body) return respond(res, 413, { error: 'payload too large' });

    const signature = header(req, 'x-signature-ed25519');
    const timestamp = header(req, 'x-signature-timestamp');
    if (!verifyInteractionSignature(this.key, signature, timestamp, body)) {
      return respond(res, 401, { error: 'invalid request signature' });
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body.toString('utf8')) as Interaction;
    } catch {
      return respond(res, 400, { error: 'invalid json' });
    }

    if (interaction.type === InteractionType.Ping) return respond(res, 200, { type: 1 });

    res.writeHead(202).end();
    this.options.onInteraction(interaction);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
