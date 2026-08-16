/** Renders the documents that have an HTML companion. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const DOCS = [
  ['SoW/STATEMENT-OF-WORK.md', 'SoW/STATEMENT-OF-WORK.html', 'Spendifre · Statement of Work'],
  ['docs/user-guide/README.md', 'docs/user-guide/index.html', 'Spendifre · User Guide'],
];

for (const [input, output, eyebrow] of DOCS) {
  await run('node', ['tools/md-to-html.mjs', input, output, eyebrow]);
  console.warn(`  ${output}`);
}
