import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function validateEncryptionKey(key: string): void {
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
}

export function encryptToken(token: string, key: string): string {
  validateEncryptionKey(key);
  const keyBuffer = Buffer.from(key, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encrypted: string, key: string): string {
  validateEncryptionKey(key);
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const keyBuffer = Buffer.from(key, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
