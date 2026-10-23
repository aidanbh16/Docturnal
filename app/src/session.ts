// Signed, short-lived tokens for the setup page: the session cookie and the OAuth state.
// The signing key is derived from WEBHOOK_SECRET, so no extra secret is needed.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, encoder.encode('docturnal-setup-v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export type TokenPurpose = 'session' | 'state';

interface Envelope<T> {
  p: TokenPurpose;
  e: number;
  d: T;
}

export async function signToken<T>(secret: string, purpose: TokenPurpose, data: T, expiresAt: number): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ p: purpose, e: expiresAt, d: data } satisfies Envelope<T>)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

// Returns the data, or null if the token is malformed, forged, expired, or for another purpose.
export async function verifyToken<T>(secret: string, purpose: TokenPurpose, token: string | null | undefined, now: number): Promise<T | null> {
  if (!token) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  try {
    // Accept only the canonical encoding: the last character has unused bits, so another
    // spelling can decode to the same bytes.
    const signatureBytes = fromBase64url(signature);
    if (base64url(signatureBytes) !== signature) return null;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signatureBytes, encoder.encode(body));
    if (!valid) return null;
    const envelope = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Envelope<T>;
    if (envelope.p !== purpose || typeof envelope.e !== 'number' || envelope.e < now) return null;
    return envelope.d;
  } catch {
    return null;
  }
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sameToken(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
