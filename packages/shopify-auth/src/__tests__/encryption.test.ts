import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../encryption.js';

const KEY = 'a'.repeat(64); // 32-byte hex key (64 hex chars)
const TOKEN = 'shpat_test_access_token_12345';

describe('encryptToken / decryptToken', () => {
  it('decrypts back to the original token', () => {
    const encrypted = encryptToken(TOKEN, KEY);
    const decrypted = decryptToken(encrypted, KEY);
    expect(decrypted).toBe(TOKEN);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const enc1 = encryptToken(TOKEN, KEY);
    const enc2 = encryptToken(TOKEN, KEY);
    expect(enc1).not.toBe(enc2);
  });

  it('throws when decrypting with wrong key', () => {
    const encrypted = encryptToken(TOKEN, KEY);
    const wrongKey = 'b'.repeat(64);
    expect(() => decryptToken(encrypted, wrongKey)).toThrow();
  });

  it('throws on malformed ciphertext', () => {
    expect(() => decryptToken('not:valid', KEY)).toThrow();
  });
});
