import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * File storage for case attachments.
 *
 * Files are written under <root>/<zone>/<case-ref>/, so the archive mirrors how
 * the business thinks about the data: everything for one request sits in one
 * directory, grouped by zone. That also means an export or a legal hold can be
 * satisfied with a directory copy.
 *
 * Nothing here is ever served from a path the client supplies — downloads go
 * through an id lookup, and the stored key is validated against the root before
 * any read, so a crafted filename cannot escape the uploads directory.
 */

/** Deliberately narrow. Anything executable or scriptable stays out. */
const ALLOWED = new Map<string, string[]>([
  ['application/pdf', ['.pdf']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/webp', ['.webp']],
  ['image/heic', ['.heic']],
  // Recorded replies: a saved email, or plain text.
  ['message/rfc822', ['.eml']],
  ['application/vnd.ms-outlook', ['.msg']],
  ['text/plain', ['.txt']],
]);

/** Magic numbers, because a browser-supplied MIME type is a claim, not a fact. */
const SIGNATURES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP
];

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface StoredFile {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  filename: string;
}

@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);

  /** Overridable so tests and development do not write into a deployment path. */
  private readonly root = resolve(process.env.UPLOAD_ROOT ?? '/opt/dsr/uploads');

  /**
   * Strip anything that could traverse or collide. The original name is kept in
   * the database for display; this is only what lands on disk.
   */
  private safeName(name: string): string {
    const base = (name || 'file').split(/[\\/]/).pop() ?? 'file';
    const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
    return cleaned || 'file';
  }

  private extensionOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
  }

  /**
   * Validate before anything is written.
   *
   * Checks the declared type, the extension and the leading bytes. A PDF that
   * claims to be a PNG, or a script renamed to .pdf, fails here.
   */
  validate(file: { originalname: string; mimetype: string; size: number; buffer: Buffer }): string {
    if (!file.buffer?.length) throw new BadRequestException('The file is empty');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller`,
      );
    }

    const declared = (file.mimetype || '').toLowerCase().split(';')[0].trim();
    const extensions = ALLOWED.get(declared);
    if (!extensions) {
      throw new BadRequestException(
        'Only PDF, PNG, JPEG, WEBP, HEIC, EML, MSG and TXT files are accepted',
      );
    }

    const ext = this.extensionOf(file.originalname);
    if (ext && !extensions.includes(ext)) {
      throw new BadRequestException(`A ${declared} file should not have a ${ext} extension`);
    }

    // Formats with a stable signature must match it.
    const signature = SIGNATURES.find((s) => s.mime === declared);
    if (signature) {
      const head = file.buffer.subarray(0, signature.bytes.length);
      const matches = signature.bytes.every((b, i) => head[i] === b);
      if (!matches) {
        throw new BadRequestException(
          `This file is not a valid ${declared.split('/')[1].toUpperCase()} — its contents do not match its type`,
        );
      }
    }

    return declared;
  }

  async save(args: {
    zoneId: string;
    caseRef: string;
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }): Promise<StoredFile> {
    const mimeType = this.validate(args);
    const filename = this.safeName(args.originalname);

    // Zone and reference are ours, not user input, but normalise anyway so a
    // malformed reference can never shape a path.
    const zone = args.zoneId.replace(/[^A-Za-z0-9_-]/g, '');
    const ref = args.caseRef.replace(/[^A-Za-z0-9_-]/g, '');
    const storageKey = `${zone}/${ref}/${randomUUID()}-${filename}`;
    const target = this.pathFor(storageKey);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.buffer, { mode: 0o640 });

    const sha256 = createHash('sha256').update(args.buffer).digest('hex');
    this.log.log(`stored ${storageKey} (${args.size} bytes)`);

    return { storageKey, sha256, sizeBytes: args.size, mimeType, filename };
  }

  /**
   * Resolve a stored key to a path, refusing anything that escapes the root.
   * The key comes from our own database, but a traversal check costs nothing
   * and turns a future bug into a refusal rather than a disclosure.
   */
  pathFor(storageKey: string): string {
    const full = resolve(this.root, storageKey);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new BadRequestException('Invalid storage key');
    }
    return full;
  }

  stream(storageKey: string): ReadStream {
    return createReadStream(this.pathFor(storageKey));
  }

  /**
   * Move a stored file into a case's directory, returning the new key.
   * Copy-then-delete rather than rename, because the uploads root may span
   * devices once storage is mounted separately.
   */
  async relocate(storageKey: string, zoneId: string, caseRef: string): Promise<string> {
    const zone = zoneId.replace(/[^A-Za-z0-9_-]/g, '');
    const ref = caseRef.replace(/[^A-Za-z0-9_-]/g, '');
    const name = storageKey.split('/').pop() ?? 'file';
    const nextKey = `${zone}/${ref}/${name}`;
    if (nextKey === storageKey) return storageKey;

    const from = this.pathFor(storageKey);
    const to = this.pathFor(nextKey);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    await unlink(from).catch(() => undefined);
    return nextKey;
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch {
      // Already gone is the desired end state.
    }
  }

  /** Where a case's files live, for support and for legal hold exports. */
  directoryFor(zoneId: string, caseRef: string): string {
    return join(this.root, zoneId, caseRef);
  }
}
