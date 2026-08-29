/**
 * Writing a CSV export to an HTTP response as it is read, rather than building
 * the whole file in memory first.
 *
 * Two things make this more than a loop around `res.write`:
 *
 * 1. Once the first byte is written the status line is gone. A failure after
 *    that point cannot be a 500, so it has to be something the operator can
 *    still see -- see `abortPartialExport`.
 * 2. `write()` returning false means the socket is full. Ignoring it buffers
 *    the entire export in memory anyway, which is the thing streaming was for.
 */

import type { Writable } from 'node:stream';
import { CSV_BOM, csvHeader, csvRow, type CsvColumn } from './csv';

/**
 * The last line of a file that died mid-flight.
 *
 * Already quoted, so it is one valid CSV field rather than something a
 * spreadsheet will split at the dashes.
 */
export const INCOMPLETE_EXPORT_MARKER =
  '"EXPORT FAILED PART WAY THROUGH - THIS FILE IS INCOMPLETE - DO NOT USE IT"';

export interface CsvStreamOutcome {
  /** Data rows written, not counting the header. */
  rows: number;
  /** What stopped the export, or null when the file was written in full. */
  error: unknown;
  /**
   * Whether `onComplete` ran without throwing. A caller that records the
   * export in that hook needs to know: if the hook succeeded and the response
   * failed afterwards, the record already exists and writing a second,
   * contradicting one would be worse than writing none.
   */
  recorded: boolean;
}

const closedMidExport = () => new Error('The client closed the connection mid-export');

/**
 * Write `chunk`, waiting out backpressure.
 *
 * Rejects if the client goes away, so a download nobody is receiving stops
 * costing database batches.
 */
export function writeChunk(out: Writable, chunk: string): Promise<void> {
  // Checked before writing, not only after. A real http.ServerResponse emits
  // 'close' and nothing else when the client aborts, and it emits it once --
  // before this call. Writing to it then returns false and no 'drain',
  // 'error' or 'close' ever follows, so a promise waiting on those three would
  // never settle and the handler would never return.
  if (out.destroyed || out.writableEnded) return Promise.reject(closedMidExport());
  if (out.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const settle = (err?: Error) => {
      out.off('drain', onDrain);
      out.off('error', onError);
      out.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => settle();
    const onError = (err: Error) => settle(err);
    const onClose = () => settle(closedMidExport());
    out.on('drain', onDrain);
    out.on('error', onError);
    out.on('close', onClose);
    // The abort can land between the write above and these listeners, in which
    // case its 'close' has already been and gone.
    if (out.destroyed) settle(closedMidExport());
  });
}

/**
 * End a half-written download in a way that cannot be mistaken for a whole one.
 *
 * Two signals, because either alone can be missed:
 *
 * - A final marker line, for a client that keeps what it received: `curl -o`
 *   leaves the partial file on disk, and a human opening it sees the marker.
 *   It opens with a CRLF of its own: the failure may have interrupted a write
 *   mid-flush, and a blank line in a file already declared unusable costs
 *   nothing next to the marker being glued onto half a row.
 * - Destroying the connection without the terminating zero-length chunk, so
 *   the HTTP client reports a failed transfer rather than a complete 200.
 *   Browsers discard the download on that; curl exits non-zero.
 *
 * A silently short file is the exact failure the streaming work exists to
 * remove, so ending cleanly here would be the one unacceptable choice.
 */
function abortPartialExport(out: Writable): void {
  if (out.destroyed || out.writableEnded) return;
  // The socket is on its way out either way: a late 'error' with nobody
  // listening is an uncaught exception rather than a failed download.
  out.on('error', () => undefined);
  // If the client has stalled without disconnecting, the write below never
  // flushes and its callback never fires; do not leave the socket open on its
  // account either.
  const giveUp = setTimeout(() => out.destroy(), 5_000);
  giveUp.unref();
  out.write(`\r\n${INCOMPLETE_EXPORT_MARKER}\r\n`, () => {
    clearTimeout(giveUp);
    out.destroy();
  });
}

/**
 * Stream `batches` as a CSV file to `out`, which the caller has already given
 * its headers. Byte-for-byte what `toCsv` would have produced for the same
 * rows: one BOM, CRLF between lines, a final CRLF.
 *
 * `onComplete` runs after the last row and before the response is ended, so a
 * caller that must record the export can fail it: if the hook throws, the
 * download is aborted like any other mid-stream failure rather than handing
 * over a file whose audit entry was never written.
 *
 * Never throws once the body has started. The outcome says what happened.
 */
export async function streamCsv<T>(
  out: Writable,
  columns: CsvColumn<T>[],
  batches: AsyncIterable<T[]>,
  onComplete?: (rows: number) => Promise<void>,
): Promise<CsvStreamOutcome> {
  let rows = 0;
  let recorded = false;
  // Two listeners, held for the whole stream, because writeChunk only listens
  // while it is waiting on drain and the interesting failures land between
  // batches, while a database query is in flight.
  //
  // 'close' is the one that matters: an aborted http.ServerResponse emits it
  // and never emits 'error' at all. 'error' is watched anyway because an
  // 'error' with nobody listening is an uncaught exception -- a crashed
  // process rather than a failed download.
  let socketError: Error | null = null;
  const noteError = (err: Error) => {
    socketError ??= err;
  };
  const noteClose = () => {
    socketError ??= closedMidExport();
  };
  const stopIfTheSocketDied = () => {
    const err = socketError;
    if (err) throw err;
  };
  out.on('error', noteError);
  out.on('close', noteClose);
  try {
    await writeChunk(out, CSV_BOM + csvHeader(columns) + '\r\n');
    for await (const batch of batches) {
      stopIfTheSocketDied();
      if (batch.length === 0) continue;
      await writeChunk(out, batch.map((row) => csvRow(row, columns)).join('\r\n') + '\r\n');
      rows += batch.length;
    }
    stopIfTheSocketDied();
    if (onComplete) {
      await onComplete(rows);
      recorded = true;
    }
    // The client can have gone while the hook was running. Ending here would
    // report a complete file that nobody received.
    stopIfTheSocketDied();
    out.end();
    return { rows, error: null, recorded };
  } catch (error) {
    abortPartialExport(out);
    return { rows, error, recorded };
  } finally {
    out.off('error', noteError);
    out.off('close', noteClose);
  }
}
