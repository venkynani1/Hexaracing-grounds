import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Compact signed tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Session tokens are short-lived and bound to a `sessions` row (hash stored, revocable).
 * Rejoin tokens carry a random secret whose SHA-256 is stored on the player row.
 */
export interface SessionClaims {
  k: 'session';
  sid: string;
  pid: string;
  tid: string;
  eid: string;
  exp: number;
}
export interface RejoinClaims {
  k: 'rejoin';
  pid: string;
  eid: string;
  sec: string;
}
export type Claims = SessionClaims | RejoinClaims;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export class TokenSigner {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('token secret required');
  }

  sign(claims: Claims): string {
    const body = b64(JSON.stringify(claims));
    return `${body}.${this.mac(body)}`;
  }

  verify<K extends Claims['k']>(token: unknown, kind: K, now = Date.now()): Extract<Claims, { k: K }> | null {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.mac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!claims || claims.k !== kind) return null;
    if (claims.k === 'session' && !(typeof claims.exp === 'number' && claims.exp > now)) return null;
    return claims as Extract<Claims, { k: K }>;
  }

  private mac(body: string) {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
