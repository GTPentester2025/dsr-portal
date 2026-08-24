import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Field-level encryption for direct identifiers (spec §9).
 *
 * Dev/test: master key from CRYPTO_MASTER_KEY (base64, 32 bytes).
 * Production: replace loadMasterKey() with a KMS data-key fetch — the
 * ciphertext format ("v1:") leaves room for a KMS-wrapped "v2:" later.
 */
@Injectable()
export class CryptoService {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(config: ConfigService) {
    const master = this.loadMasterKey(config);
    this.encKey = Buffer.from(hkdfSync('sha256', master, 'dsr', 'field-encryption', 32));
    this.hmacKey = Buffer.from(hkdfSync('sha256', master, 'dsr', 'lookup-hmac', 32));
  }

  private loadMasterKey(config: ConfigService): Buffer {
    const b64 = config.get<string>('CRYPTO_MASTER_KEY');
    if (!b64) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('CRYPTO_MASTER_KEY must be set in production');
      }
      // deterministic dev key so local data survives restarts
      return createHash('sha256').update('dsr-dev-master-key').digest();
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('CRYPTO_MASTER_KEY must be 32 bytes (base64)');
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, ivB64, ctB64, tagB64] = payload.split(':');
    if (version !== 'v1') throw new Error(`Unknown ciphertext version: ${version}`);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Deterministic keyed hash for equality lookups (e.g. requester email). */
  lookupHmac(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value.trim().toLowerCase()).digest('hex');
  }

  sha256Hex(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  safeEqualHex(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
