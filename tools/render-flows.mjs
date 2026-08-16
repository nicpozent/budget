/**
 * Renders SoW/flows/*.mmd to SoW/images/*.svg.
 *
 * mermaid-cli drives a headless browser, so the executable path is passed via a
 * puppeteer config file. In this environment Chromium is pre-installed; on a
 * developer machine, omit CHROMIUM_PATH and let puppeteer use its own.
 */
import { readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const IN = 'SoW/flows';
const OUT = 'SoW/images';
const CHROMIUM = process.env.CHROMIUM_PATH;

await mkdir(OUT, { recursive: true });

let configArgs = [];
if (CHROMIUM) {
  const cfg = path.join(OUT, '.puppeteer.json');
  await writeFile(cfg, JSON.stringify({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  }));
  configArgs = ['-p', cfg];
}

const files = (await readdir(IN)).filter((f) => f.endsWith('.mmd')).sort();
for (const file of files) {
  const name = path.basename(file, '.mmd');
  await run('npx', [
    'mmdc', ...configArgs,
    '-i', path.join(IN, file),
    '-o', path.join(OUT, `${name}.svg`),
    '-b', 'transparent', '-t', 'neutral',
  ]);
  console.warn(`  ${name}.svg`);
}
if (CHROMIUM) await rm(path.join(OUT, '.puppeteer.json'), { force: true });
console.warn(`rendered ${files.length} flows`);
