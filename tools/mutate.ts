/**
 * Mutation testing for `packages/shared` (row 14 of the evaluation).
 *
 *   node --experimental-strip-types tools/mutate.ts [--threshold 85] [--file money.ts]
 *
 * Line coverage says a line ran. It does not say an assertion depended on it,
 * and the difference matters most exactly where this repository is least able
 * to afford being wrong: `Money`, the permission matrix, and the input
 * grammars. A test that calls `multiplyByRate` and asserts nothing about the
 * rounding covers every line of it.
 *
 * So: change the code deliberately, and see whether the suite notices. Each
 * mutant flips one operator — a `<` to a `<=`, an `&&` to an `||`, a `true` to
 * a `false` — and `test/shared.test.ts` is re-run against it. A mutant the
 * suite fails on is *killed*. One that survives is a change to the product
 * nobody would have caught, and the report names the file and line.
 *
 * ## Why this is not Stryker
 *
 * The same reason `tools/loadtest.ts` is not k6 (ADR-0004). Stryker is a good
 * tool and it would take a dependency tree that has to be trusted, patched and
 * audited to run a loop that is a hundred lines long. What it needs that is
 * genuinely hard — a TypeScript parser and printer — is `typescript`, which is
 * already a dev dependency because the build uses it. Nothing new is
 * installed.
 *
 * The trade is real and worth stating: no incremental mode, no coverage-based
 * test selection, no HTML report. It runs the whole shared suite once per
 * mutant, which takes about a second and a half, which is why the shared suite
 * has no database fixture and why this runs nightly rather than per push.
 *
 * ## The operator set
 *
 * Conditional boundaries, equality, logical connectives, unary negation and
 * boolean literals — the classic core. Deliberately *not* string literals: the
 * strings in this package are error messages and regular expressions, and the
 * suite asserts on `MoneyError` the class rather than its wording, so blanking
 * a message would produce survivors that are correct behaviour rather than
 * gaps. An operator set tuned to produce a flattering score is worse than none.
 *
 * ## Equivalent mutants
 *
 * Some mutations cannot change behaviour. `numerator < 0n` widened to `<= 0n`
 * flips a sign flag when the numerator is zero, and the result is `-0n`, which
 * is `0n`. No assertion can distinguish it because there is nothing to
 * distinguish. Left in the report those become a survivor list that never
 * empties, and a list that never empties is one nobody reads.
 *
 * So a source line may carry `mutate-ignore: <operator> — <reason>`, naming
 * one operator swap and why it is equivalent. It is deliberately per-operator
 * rather than per-line: the same line usually carries killable mutants too.
 * Ignored mutants are counted and printed separately from the score, never
 * folded silently into it, and a marker matching no live mutant is reported —
 * the same discipline `EXCLUDED_FROM_BACKUP` gets, for the same reason.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'packages/shared/src');
const SUITE = 'test/shared.test.ts';

/** Files whose only content is re-exports have nothing to mutate. */
const SKIP = new Set(['index.ts']);

interface Args {
  threshold: number;
  file: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { threshold: 85, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--threshold') args.threshold = Number(argv[i + 1]);
    if (argv[i] === '--file') args.file = argv[i + 1] ?? null;
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 100) {
    throw new Error('--threshold must be a percentage');
  }
  return args;
}

/**
 * Operator swaps, as text. Both directions of each pair, because a suite can
 * be blind in one direction and not the other — `<` to `<=` is an off-by-one
 * and `<=` to `<` is the other off-by-one, and they are caught by different
 * cases.
 */
const BINARY_SWAPS: Readonly<Record<string, readonly string[]>> = {
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '===': ['!=='],
  '!==': ['==='],
  '==': ['!='],
  '!=': ['=='],
  '&&': ['||'],
  '||': ['&&'],
  '+': ['-'],
  '-': ['+'],
  '*': ['/'],
  '/': ['*'],
  '%': ['*'],
};

/**
 * `mutate-ignore: === -> !== — why`. The operator is matched exactly against
 * the mutant's own description, so a marker cannot silence a swap it does not
 * name, and the reason is required.
 */
const IGNORE_RE = /mutate-ignore:\s*([^—]+?)\s*—\s*\S/g;

interface Mutant {
  file: string;
  /** Byte offsets into the original source. */
  start: number;
  end: number;
  replacement: string;
  original: string;
  line: number;
  operator: string;
  /** Non-null when a `mutate-ignore` marker names this swap. */
  ignoredBecause: string | null;
  /** Which line that marker was on, so a stale one can be identified. */
  ignoredAt: number | null;
}

/** The text of a 1-based line, for reading its comment markers. */
function lineText(source: string, line: number): string {
  return source.split('\n')[line - 1] ?? '';
}

/**
 * A marker sits on the mutated line or on the line above it. Both, because a
 * short expression takes a trailing comment comfortably and a long one does
 * not, and forcing the marker onto one of them would push lines past the width
 * the rest of the file keeps to.
 */
function findMarker(
  source: string, line: number, operator: string,
): { reason: string; at: number } | null {
  for (const candidate of [line, line - 1]) {
    const text = lineText(source, candidate);
    for (const match of text.matchAll(IGNORE_RE)) {
      if (match[1]?.trim() === operator) {
        return { reason: text.slice(match.index).trim(), at: candidate };
      }
    }
  }
  return null;
}

function collect(file: string, source: string): Mutant[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const mutants: Mutant[] = [];

  const at = (start: number) => tree.getLineAndCharacterOfPosition(start).line + 1;

  const push = (
    start: number, end: number, replacement: string, operator: string,
  ) => {
    const line = at(start);
    const marker = findMarker(source, line, operator);
    mutants.push({
      file, start, end, replacement,
      original: source.slice(start, end),
      line,
      operator,
      ignoredBecause: marker?.reason ?? null,
      ignoredAt: marker?.at ?? null,
    });
  };

  const visit = (node: ts.Node): void => {
    // Type positions contain tokens that look like operators to a text-level
    // replacement and are not expressions at all.
    if (ts.isTypeNode(node)) return;

    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const text = token.getText(tree);
      for (const replacement of BINARY_SWAPS[text] ?? []) {
        push(token.getStart(tree), token.getEnd(), replacement, `${text} -> ${replacement}`);
      }
    }

    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      // Drop the negation: `if (!ok)` becomes `if (ok)`.
      push(node.getStart(tree), node.operand.getStart(tree), '', '! removed');
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      push(node.getStart(tree), node.getEnd(), 'false', 'true -> false');
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      push(node.getStart(tree), node.getEnd(), 'true', 'false -> true');
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(tree, visit);
  // Later offsets first is irrelevant here — one mutation is applied at a time
  // against the pristine source — but a stable order makes the report readable.
  return mutants.sort((a, b) => a.start - b.start);
}

function runSuite(): 'pass' | 'fail' {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', SUITE, '--silent', '--reporter=dot'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      // A mutant can turn a bounded loop into an unbounded one. A hung run is
      // a killed mutant, which is what every mutation tester does and is the
      // conservative reading: the suite did not accept it.
      timeout: 60_000,
      env: { ...process.env, CI: '1' },
    },
  );
  return result.status === 0 ? 'pass' : 'fail';
}

/**
 * Every `mutate-ignore` marker in the sources, minus the ones a mutant claimed.
 */
function staleMarkers(
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
  mutants: readonly Mutant[],
): string[] {
  const claimed = new Set(
    mutants
      .filter((m) => m.ignoredAt !== null)
      .map((m) => `${m.file}:${m.ignoredAt}:${m.operator}`),
  );
  const stale: string[] = [];
  for (const file of files) {
    const lines = (sources.get(file) ?? '').split('\n');
    for (const [index, text] of lines.entries()) {
      IGNORE_RE.lastIndex = 0;
      for (const match of text.matchAll(IGNORE_RE)) {
        const operator = match[1]?.trim() ?? '';
        if (!claimed.has(`${file}:${index + 1}:${operator}`)) {
          stale.push(`${file}:${index + 1}  ${operator}`);
        }
      }
    }
  }
  return stale;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const files = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !SKIP.has(f))
    .filter((f) => args.file === null || f === args.file)
    .sort();
  if (files.length === 0) throw new Error('no source files matched');

  const sources = new Map(files.map((f) => [f, readFileSync(path.join(SRC, f), 'utf8')]));

  // A red baseline would kill every mutant and report a perfect score, which is
  // the one failure mode of a mutation run that looks like success.
  process.stdout.write('baseline… ');
  if (runSuite() === 'fail') {
    throw new Error(`${SUITE} fails before any mutation; fix it first`);
  }
  process.stdout.write('green\n');

  const every = files.flatMap((f) => collect(f, sources.get(f)!));
  const ignored = every.filter((m) => m.ignoredBecause !== null);
  const all = every.filter((m) => m.ignoredBecause === null);
  process.stdout.write(
    `${all.length} mutants across ${files.length} files` +
      (ignored.length > 0 ? `, ${ignored.length} marked equivalent\n\n` : '\n\n'),
  );

  const survivors: Mutant[] = [];
  let killed = 0;

  const restore = () => {
    for (const [f, text] of sources) writeFileSync(path.join(SRC, f), text);
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  try {
    for (const [index, mutant] of all.entries()) {
      const original = sources.get(mutant.file)!;
      const mutated =
        original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end);
      writeFileSync(path.join(SRC, mutant.file), mutated);

      const outcome = runSuite();
      writeFileSync(path.join(SRC, mutant.file), original);

      if (outcome === 'fail') killed += 1;
      else survivors.push(mutant);

      const score = ((killed / (index + 1)) * 100).toFixed(1);
      process.stdout.write(
        `\r${index + 1}/${all.length}  killed ${killed}  survived ${survivors.length}  ${score}%   `,
      );
    }
  } finally {
    restore();
  }

  const score = all.length === 0 ? 100 : (killed / all.length) * 100;
  process.stdout.write('\n\n');

  if (ignored.length > 0) {
    // Printed every run, not hidden behind a flag. An exemption nobody sees is
    // an exemption nobody revisits.
    process.stdout.write('excluded as equivalent, outside the score:\n');
    for (const m of ignored) {
      process.stdout.write(`  ${m.file}:${m.line}  ${m.operator}\n`);
    }
    process.stdout.write('\n');
  }

  if (survivors.length > 0) {
    process.stdout.write('survived — no assertion depends on these:\n');
    for (const s of survivors) {
      process.stdout.write(`  ${s.file}:${s.line}  ${s.operator}\n`);
    }
    process.stdout.write('\n');
  }

  // A marker whose operator no longer appears is a claim about code that has
  // moved on. Reported rather than tolerated, and it fails the run: a stale
  // exemption is how a real gap gets silenced later.
  const stale = staleMarkers(files, sources, every);
  if (stale.length > 0) {
    process.stdout.write('stale mutate-ignore markers, matching no mutant:\n');
    for (const line of stale) process.stdout.write(`  ${line}\n`);
    process.stdout.write('\n');
    process.exitCode = 1;
  }

  process.stdout.write(
    `mutation score ${score.toFixed(1)}% (${killed}/${all.length}), threshold ${args.threshold}%\n`,
  );
  if (score < args.threshold) {
    process.stdout.write('below threshold\n');
    process.exitCode = 1;
  }
}

await main();
