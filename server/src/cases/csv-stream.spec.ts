import { PassThrough } from 'node:stream';
import { toCsv, type CsvColumn } from './csv';
import { INCOMPLETE_EXPORT_MARKER, streamCsv, writeChunk } from './csv-stream';

interface Row { name: string; note: string }
const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Note', value: (r) => r.note },
];
const ROWS: Row[] = [
  { name: 'Ada', note: 'plain' },
  { name: 'Bob', note: 'has, comma' },
  { name: 'Cy', note: '=HYPERLINK("http://evil")' },
];

/** Collect the bytes as they are written, so a later destroy cannot lose them. */
function collect(sink: PassThrough): { text: () => string } {
  const chunks: string[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { text: () => chunks.join('') };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('writeChunk', () => {
  it('waits for drain rather than buffering', async () => {
    const sink = new PassThrough({ highWaterMark: 8 });
    let done = false;
    const pending = writeChunk(sink, 'x'.repeat(256)).then(() => {
      done = true;
    });
    await tick();
    // The socket is full and nobody is reading: a loop that ignored this is
    // how the whole export ends up in memory anyway.
    expect(done).toBe(false);
    sink.resume();
    await pending;
    expect(done).toBe(true);
  });

  it('rejects a write to a response the client has already closed', async () => {
    // The ordering a real http.ServerResponse produces: it emits 'close' once,
    // when the client aborts, and never emits anything again. A write after
    // that returns false and is followed by no 'drain', no 'error' and no
    // 'close', so anything waiting on those three waits for ever.
    const sink = new PassThrough({ highWaterMark: 8 });
    sink.destroy();
    await expect(writeChunk(sink, 'x'.repeat(256))).rejects.toThrow(/closed the connection/);
  });

  it('rejects when the client goes away mid-write', async () => {
    const sink = new PassThrough({ highWaterMark: 8 });
    const pending = writeChunk(sink, 'x'.repeat(256));
    await tick();
    sink.destroy();
    await expect(pending).rejects.toThrow(/closed the connection/);
  });
});

describe('streamCsv', () => {
  it('writes the same bytes the buffered export would have', async () => {
    const sink = new PassThrough();
    const seen = collect(sink);
    async function* batches() {
      yield ROWS.slice(0, 2);
      yield ROWS.slice(2);
    }
    const outcome = await streamCsv(sink, COLUMNS, batches());
    expect(outcome).toEqual({ rows: 3, error: null, recorded: false });
    expect(seen.text()).toBe(toCsv(ROWS, COLUMNS));
  });

  it('writes a header-only file when nothing matched', async () => {
    const sink = new PassThrough();
    const seen = collect(sink);
    async function* batches(): AsyncGenerator<Row[]> {}
    const outcome = await streamCsv(sink, COLUMNS, batches());
    expect(outcome.rows).toBe(0);
    expect(seen.text()).toBe(toCsv([], COLUMNS));
  });

  it('marks and aborts a file that failed part way through', async () => {
    const sink = new PassThrough();
    const seen = collect(sink);
    async function* batches(): AsyncGenerator<Row[]> {
      yield ROWS.slice(0, 2);
      throw new Error('the connection died on batch two');
    }
    const outcome = await streamCsv(sink, COLUMNS, batches());
    await tick();

    expect((outcome.error as Error).message).toContain('batch two');
    expect(outcome.rows).toBe(2);
    // The status was 200 long before this went wrong, so the only remaining
    // signals are the marker in the file and a transfer that never terminates.
    expect(seen.text()).toContain(INCOMPLETE_EXPORT_MARKER);
    expect(seen.text()).not.toBe(toCsv(ROWS.slice(0, 2), COLUMNS));
    expect(sink.destroyed).toBe(true);
    expect(sink.writableFinished).toBe(false);
  });

  it('stops when the client closes between batches', async () => {
    const sink = new PassThrough();
    sink.resume();
    async function* batches(): AsyncGenerator<Row[]> {
      yield ROWS.slice(0, 1);
      // An operator who clicked Export and navigated away. Nothing emits
      // 'error' here -- only 'close' -- and the next write would otherwise
      // hang the handler for the life of the process, holding the response,
      // the generator and a batch of decrypted requester addresses.
      sink.destroy();
      await tick();
      yield ROWS.slice(1);
    }
    const outcome = await streamCsv(sink, COLUMNS, batches());
    expect((outcome.error as Error).message).toMatch(/closed the connection/);
    expect(outcome.rows).toBe(1);
  });

  it('stops when the response itself fails between batches', async () => {
    const sink = new PassThrough();
    sink.resume();
    async function* batches(): AsyncGenerator<Row[]> {
      yield ROWS.slice(0, 1);
      // What a dropped connection looks like from here. Nothing else is
      // listening for it, and an unheard 'error' would take the process down.
      sink.emit('error', new Error('socket hang up'));
      await tick();
      yield ROWS.slice(1);
    }
    const outcome = await streamCsv(sink, COLUMNS, batches());
    expect((outcome.error as Error).message).toBe('socket hang up');
    expect(outcome.rows).toBe(1);
  });

  it('aborts when the export cannot be recorded', async () => {
    const sink = new PassThrough();
    const seen = collect(sink);
    async function* batches() {
      yield ROWS;
    }
    const outcome = await streamCsv(sink, COLUMNS, batches(), async () => {
      throw new Error('audit write failed');
    });
    await tick();

    // An unrecorded export of personal data is not a completed export.
    expect(outcome.recorded).toBe(false);
    expect((outcome.error as Error).message).toBe('audit write failed');
    expect(seen.text()).toContain(INCOMPLETE_EXPORT_MARKER);
    expect(sink.destroyed).toBe(true);
  });

  it('reports the row count to the completion hook', async () => {
    const sink = new PassThrough();
    sink.resume();
    async function* batches() {
      yield ROWS.slice(0, 2);
      yield ROWS.slice(2);
    }
    const counted: number[] = [];
    const outcome = await streamCsv(sink, COLUMNS, batches(), async (n) => {
      counted.push(n);
    });
    expect(counted).toEqual([3]);
    // The caller uses this to avoid recording a contradicting second entry if
    // the response fails after the export was already recorded.
    expect(outcome.recorded).toBe(true);
  });
});
