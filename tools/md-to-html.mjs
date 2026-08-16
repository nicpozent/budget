/**
 * Renders one of the project's Markdown documents to a styled, self-contained
 * HTML page.
 *
 * Deliberately a small purpose-built converter rather than a Markdown library:
 * it handles exactly the constructs these documents use, produces output that
 * matches the flow gallery's styling, and escapes everything by default — the
 * inverse of a general renderer, which passes raw HTML through.
 *
 *   node tools/md-to-html.mjs <input.md> <output.html> "<eyebrow>"
 */

import { readFile, writeFile } from 'node:fs/promises';

const [input, output, eyebrow = 'Spendifre'] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: md-to-html.mjs <input.md> <output.html> [eyebrow]');
  process.exit(1);
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline spans. Escaping happens first, so no source markup can inject HTML. */
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safe = /^(https?:|\.{0,2}\/|#)/.test(href) ? href : '#';
    return `<a href="${safe}">${label}</a>`;
  });
  return out;
}

const slug = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function render(md) {
  const lines = md.split('\n');
  const html = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code (including mermaid, kept as a labelled block).
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;
      html.push(
        `<pre class="code${lang ? ` lang-${lang}` : ''}">` +
          (lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '') +
          `<code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // Tables.
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s:|-]+\|$/)) {
      const cells = (row) =>
        row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith('|')) body.push(cells(lines[i++]));
      html.push(
        '<div class="tablewrap"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slug(text);
      if (level === 2) toc.push({ id, text });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote.
    if (line.startsWith('> ')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    // Lists (single level is all these documents use).
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        i += 1;
        // Continuation lines.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          item += ` ${lines[i].trim()}`;
          i += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph.
    const body = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('|') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      body.push(lines[i++]);
    }
    html.push(`<p>${inline(body.join(' '))}</p>`);
  }

  return { html: html.join('\n'), toc };
}

const STYLE = `<style>
  :root{--bg:#f6f8f7;--surface:#ffffff;--ink:#0c111e;--body:#333c4d;--muted:#55647c;--faint:#8994a6;
    --accent:#0b7a5a;--accent-ink:#08573f;--accent-soft:#e9f6f1;--accent-line:#bfe0d4;--border:#e2e8ea;
    --code-bg:#f2f5f4;--shadow:0 1px 2px rgba(12,17,30,.06),0 8px 26px rgba(12,17,30,.07);--radius:12px;
    --font-body:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --font-mono:'JetBrains Mono',ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0a0e17;--surface:#0c111e;--ink:#e6edf7;--body:#c3ccdb;--muted:#93a1b8;--faint:#7d8ca6;--accent:#34d399;--accent-ink:#5fe0b3;--accent-soft:#0f2b23;--accent-line:#1e4a3c;--border:#1a2335;--code-bg:#111a2b;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);}}
  :root[data-theme="dark"]{--bg:#0a0e17;--surface:#0c111e;--ink:#e6edf7;--body:#c3ccdb;--muted:#93a1b8;--faint:#7d8ca6;--accent:#34d399;--accent-ink:#5fe0b3;--accent-soft:#0f2b23;--accent-line:#1e4a3c;--border:#1a2335;--code-bg:#111a2b;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);}
  *{box-sizing:border-box} body{background:var(--bg);color:var(--body);font-family:var(--font-body);margin:0;line-height:1.65;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:64rem;margin:0 auto;padding:clamp(1.25rem,4vw,3rem) clamp(1rem,4vw,2.5rem) 4rem;}
  header.top{border-bottom:2px solid var(--accent);padding-bottom:1.3rem;margin-bottom:1.6rem;}
  .eyebrow{font-family:var(--font-mono);font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:var(--accent-ink);font-weight:600;margin:0 0 .55rem;}
  h1{color:var(--ink);font-size:clamp(1.7rem,4vw,2.4rem);line-height:1.12;letter-spacing:-.015em;margin:0;font-weight:700;}
  h2{color:var(--ink);font-size:1.32rem;font-weight:700;margin:2.6rem 0 .9rem;padding-bottom:.45rem;border-bottom:1px solid var(--accent-line);scroll-margin-top:1rem;}
  h3{color:var(--ink);font-size:1.06rem;font-weight:650;margin:1.9rem 0 .6rem;}
  h4{color:var(--ink);font-size:.97rem;font-weight:650;margin:1.4rem 0 .4rem;}
  p{margin:.75rem 0;} a{color:var(--accent-ink);text-underline-offset:2px;}
  ul,ol{margin:.7rem 0;padding-left:1.4rem;} li{margin:.3rem 0;}
  blockquote{margin:1.2rem 0;padding:.85rem 1.1rem;background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 var(--radius) var(--radius) 0;color:var(--body);}
  blockquote p{margin:0;}
  code{font-family:var(--font-mono);font-size:.86em;background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:.06em .35em;}
  pre.code{position:relative;background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;overflow-x:auto;margin:1.1rem 0;}
  pre.code code{background:none;border:0;padding:0;font-size:.82rem;line-height:1.55;}
  pre.code .lang{position:absolute;top:.5rem;right:.7rem;font-family:var(--font-mono);font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);}
  .tablewrap{overflow-x:auto;margin:1.1rem 0;border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);background:var(--surface);}
  table{border-collapse:collapse;width:100%;font-size:.9rem;}
  th,td{text-align:left;padding:.6rem .85rem;border-bottom:1px solid var(--border);vertical-align:top;}
  thead th{background:var(--accent-soft);color:var(--ink);font-weight:650;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;}
  tbody tr:last-child td{border-bottom:0;}
  hr{border:0;border-top:1px solid var(--border);margin:2.2rem 0;}
  nav.toc{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.2rem;margin:0 0 2rem;box-shadow:var(--shadow);}
  nav.toc p{margin:0 0 .5rem;font-family:var(--font-mono);font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);font-weight:600;}
  nav.toc ol{columns:2;column-gap:2rem;margin:0;padding-left:1.2rem;font-size:.9rem;}
  @media (max-width:44rem){nav.toc ol{columns:1;}}
  footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem;}
</style>`;

const md = await readFile(input, 'utf8');
const firstHeading = md.match(/^#\s+(.*)$/m)?.[1] ?? 'Document';
const { html, toc } = render(md.replace(/^#\s+.*$/m, ''));

const page = `${STYLE}
<div class="wrap">
<header class="top"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${inline(firstHeading)}</h1></header>
${toc.length > 3 ? `<nav class="toc"><p>Contents</p><ol>${toc.map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('')}</ol></nav>` : ''}
${html}
<footer>Generated from <code>${escapeHtml(input)}</code>. Regenerate with <code>npm run docs:html</code>.</footer>
</div>
`;

await writeFile(output, page, 'utf8');
console.warn(`${input} -> ${output}`);
