import { isPdf, nextStage, permits } from './delegation-rules';

/**
 * The stage table is the whole security model of the link: what a token can do
 * is decided here and nowhere else, so every combination is pinned down rather
 * than only the interesting ones.
 */
describe('permits', () => {
  it('allows accepting only while the delegation is unanswered', () => {
    expect(permits('sent', 'accept')).toBe(true);
    expect(permits('accepted', 'accept')).toBe(false);
    expect(permits('closed', 'accept')).toBe(false);
  });

  it('allows uploading only after somebody has accepted', () => {
    expect(permits('sent', 'upload')).toBe(false);
    expect(permits('accepted', 'upload')).toBe(true);
    expect(permits('closed', 'upload')).toBe(false);
  });

  it('allows the page to be read at every stage, including closed', () => {
    // A dead end that explains itself is worth more than a 404, and it
    // discloses nothing the holder of the link did not already have.
    expect(permits('sent', 'view')).toBe(true);
    expect(permits('accepted', 'view')).toBe(true);
    expect(permits('closed', 'view')).toBe(true);
  });

  it('permits nothing for a stage it does not recognise', () => {
    expect(permits('nonsense' as never, 'accept')).toBe(false);
    expect(permits('nonsense' as never, 'upload')).toBe(false);
    expect(permits('nonsense' as never, 'view')).toBe(false);
  });
});

describe('nextStage', () => {
  it('moves the delegation on', () => {
    expect(nextStage('accept')).toBe('accepted');
    expect(nextStage('close')).toBe('closed');
  });

  it('leaves the stage alone for an upload', () => {
    // Uploading is not progress: HR may send three documents.
    expect(nextStage('upload')).toBeNull();
  });
});

describe('isPdf', () => {
  it('accepts a real PDF', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\nstuff'))).toBe(true);
  });

  it('rejects an executable renamed to .pdf', () => {
    // The obvious attack on an upload box open to unauthenticated callers.
    expect(isPdf(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe(false);
  });

  it('rejects HTML, which a browser would happily run', () => {
    expect(isPdf(Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
  });

  it('rejects a file too short to have a header', () => {
    expect(isPdf(Buffer.from('%PD'))).toBe(false);
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });

  it('rejects a PDF header that is not at the start', () => {
    expect(isPdf(Buffer.from('   %PDF-1.7'))).toBe(false);
  });
});
