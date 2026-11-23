// Ed25519 request verification for HTTP interactions (Interactions Overview →
// "Validating Security Request Headers"), using node:crypto only.

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export function publicKeyFromHex(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('DISCORD_PUBLIC_KEY must be 64 hex characters');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

export function verifyInteractionSignature(
  key: KeyObject,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: Buffer,
  options: { now?: number; maxSkewSeconds?: number } = {},
): boolean {
  if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d+$/.test(timestamp)) return false;
  // Reject stale or far-future requests to limit replay attacks.
  const skew = Math.abs((options.now ?? Date.now()) / 1000 - Number(timestamp));
  if (skew > (options.maxSkewSeconds ?? 300)) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
