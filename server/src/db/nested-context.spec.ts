/**
 * A `db.system()` or `db.withContext()` opened *inside* another one does not
 * join the outer transaction. It checks out a second connection from the pool
 * and holds both until the inner call returns.
 *
 * That went unnoticed in `CasesService.detail` for a long time: a nested
 * `system()` fetched the approver list while the caller's own connection was
 * still open, so every case view took two of the pool's ten connections to
 * answer one request. Nothing failed, no test complained, and the cost only
 * showed up as capacity that quietly was not there.
 *
 * It is a comfortable mistake to make -- the inner call reads as "just one
 * more query" -- so this asserts the invariant rather than trusting that
 * someone will notice next time.
 *
 * The scanner has to paren-match, and these files are full of SQL in template
 * literals containing `count(*)` and the like, so it skips strings, template
 * literals and comments. The fixture tests below exist because a scanner that
 * silently stopped matching would report zero findings and look like success.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..');
const BACKSLASH = String.fromCharCode(92);

interface Span {
  kind: string;
  start: number;
  end: number;
}

/** Every `db.withContext(...)` / `db.system(...)` call, with its full extent. */
export function callSpans(src: string): Span[] {
  const out: Span[] = [];
  const re = /\bdb\.(withContext|system)\s*\(/g;
  const n = src.length;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    let j = m.index + m[0].length - 1; // on the '('
    let depth = 0;
    let inTemplate = false;

    while (j < n) {
      const c = src[j];
      const next = j + 1 < n ? src[j + 1] : '';

      if (!inTemplate && c === '/' && next === '/') {
        const k = src.indexOf('\n', j);
        j = k < 0 ? n : k;
        continue;
      }
      if (!inTemplate && c === '/' && next === '*') {
        const k = src.indexOf('*/', j);
        j = k < 0 ? n : k + 2;
        continue;
      }
      if (!inTemplate && (c === '"' || c === "'")) {
        const quote = c;
        j += 1;
        while (j < n && src[j] !== quote) j += src[j] === BACKSLASH ? 2 : 1;
        j += 1;
        continue;
      }
      if (c === '`') {
        inTemplate = !inTemplate;
        j += 1;
        continue;
      }
      if (inTemplate) {
        // Only a ${ ... } hole inside a template holds real code.
        if (c === '$' && next === '{') {
          let k = j + 2;
          let braces = 1;
          while (k < n && braces > 0) {
            if (src[k] === '{') braces += 1;
            else if (src[k] === '}') braces -= 1;
            k += 1;
          }
          j = k;
          continue;
        }
        j += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push({ kind: m[1], start: m.index, end: j });
          break;
        }
      }
      j += 1;
    }
  }
  return out;
}

/** Human-readable `outer( line N contains inner( line M` for each nesting. */
export function nestedCalls(src: string): string[] {
  const spans = callSpans(src);
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;
  const found: string[] = [];
  for (const outer of spans) {
    for (const inner of spans) {
      if (inner.start > outer.start && inner.end < outer.end) {
        found.push(
          `${outer.kind}( at line ${lineOf(outer.start)} contains ` +
            `${inner.kind}( at line ${lineOf(inner.start)}`,
        );
      }
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('the scanner itself', () => {
  it('spots a call nested inside another', () => {
    const src = `
      return this.db.withContext(ctx, async (db, client) => {
        const row = await client.query('SELECT 1');
        const more = await this.db.system(async (_d, c) => c.query('SELECT 2'));
        return { row, more };
      });`;
    expect(nestedCalls(src)).toHaveLength(1);
    expect(nestedCalls(src)[0]).toMatch(/withContext\(.*contains system\(/);
  });

  it('does not flag two calls that merely follow one another', () => {
    const src = `
      const a = await this.db.system(async (_d, c) => c.query('SELECT 1'));
      const b = await this.db.withContext(ctx, async (_d, c) => c.query('SELECT 2'));`;
    expect(callSpans(src)).toHaveLength(2);
    expect(nestedCalls(src)).toEqual([]);
  });

  it('is not thrown off by parentheses inside SQL', () => {
    // The reason this scanner needs a lexer at all: count(*) FILTER (WHERE ...)
    // would unbalance a naive matcher and swallow everything after it.
    const src = [
      'const a = await this.db.system(async (_d, c) =>',
      '  c.query(`SELECT count(*) FILTER (WHERE x) AS n FROM t WHERE y = $1`, [z]));',
      'const b = await this.db.system(async (_d, c) => c.query(`SELECT 2`));',
    ].join('\n');
    expect(callSpans(src)).toHaveLength(2);
    expect(nestedCalls(src)).toEqual([]);
  });

  it('is not thrown off by a bracket inside a quoted string or a comment', () => {
    const src = [
      "const a = await this.db.system(async (_d, c) => c.query('SELECT )))'));",
      '// const b = await this.db.system(async () => {',
      'const c2 = await this.db.system(async (_d, c) => c.query(`SELECT 1`));',
    ].join('\n');
    expect(callSpans(src)).toHaveLength(2);
    expect(nestedCalls(src)).toEqual([]);
  });
});

describe('no database call opens another', () => {
  it('holds across every source file', () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of sourceFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8');
      scanned += callSpans(src).length;
      for (const hit of nestedCalls(src)) {
        offenders.push(`${file.replace(/\\/g, '/').split('/src/')[1]}: ${hit}`);
      }
    }

    // If this ever reaches zero the walk has broken and the assertion below
    // would pass by finding nothing to look at.
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
