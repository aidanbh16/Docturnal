import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPkcs8, toPkcs8Pem } from '../scripts/pkcs8.mjs';

describe('PKCS#1 to PKCS#8 conversion used by register.html', () => {
  it('produces the same key as Node (and openssl pkcs8 -topk8)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const expected = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(pkcs1).toContain('BEGIN RSA PRIVATE KEY');
    const converted = toPkcs8Pem(pkcs1);
    expect(converted).toBe(expected);
    await checkPkcs8(converted);
  });

  it('leaves a PKCS#8 key alone and rejects anything else', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(toPkcs8Pem(pkcs8)).toBe(pkcs8);
    expect(() => toPkcs8Pem('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')).toThrow(/neither PKCS#1/);
  });
});
