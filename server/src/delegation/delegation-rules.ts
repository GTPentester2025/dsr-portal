/**
 * What a delegation link may do, and what may be uploaded through it.
 *
 * Pure and dependency-free, because this is the security model of a URL handed
 * to people with no account: it should be readable in one sitting and testable
 * without a database.
 */

export type DelegationStage = 'sent' | 'accepted' | 'closed';
export type DelegationAction = 'view' | 'accept' | 'upload';

/**
 * Each action is possible in exactly one stage, which is what "the link
 * expires when the stage changes" amounts to. Viewing is the exception: a
 * closed delegation still renders a page saying so, because a dead end that
 * explains itself is more use to the person holding the link than an error,
 * and it discloses nothing they did not already have.
 */
const ALLOWED: Record<DelegationStage, DelegationAction[]> = {
  sent: ['view', 'accept'],
  accepted: ['view', 'upload'],
  closed: ['view'],
};

export function permits(stage: DelegationStage, action: DelegationAction): boolean {
  return (ALLOWED[stage] ?? []).includes(action);
}

/** The stage an action moves the delegation to, or null if it does not. */
export function nextStage(action: 'accept' | 'upload' | 'close'): DelegationStage | null {
  if (action === 'accept') return 'accepted';
  if (action === 'close') return 'closed';
  // Uploading is not progress: one delegation may receive several documents.
  return null;
}

/** `%PDF-`, which every PDF starts with. */
export const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * Whether these bytes are a PDF, judged by the bytes.
 *
 * Never by the filename or the declared Content-Type: both are supplied by the
 * uploader, and an executable named `report.pdf` is the first thing anybody
 * tries against an upload box that does not need a login.
 */
export function isPdf(buffer: Buffer): boolean {
  if (buffer.length < PDF_MAGIC.length) return false;
  return buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}
