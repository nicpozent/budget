/**
 * XLSX export (FR-064) with formula-injection defence (SEC-023).
 *
 * Written against the OOXML and ZIP formats directly rather than through a
 * spreadsheet library. Two reasons, both security ones: the export path is the
 * place where our data crosses into someone else's trust boundary (their
 * Excel), so the escaping rule needs to be visible at the point of writing
 * rather than buried in a dependency's option; and every spreadsheet library we
 * looked at pulled in a large transitive tree, which is exactly the supply
 * chain surface SEC-040 asks us to keep small.
 */

import { deflateRawSync } from 'node:zlib';

/**
 * SEC-023. Excel, LibreOffice and Google Sheets all treat a leading `=`, `+`,
 * `-`, `@`, tab or carriage return as the start of a formula. A cell holding
 * `=cmd|'/c calc'!A1` becomes remote code execution on the recipient's machine
 * — the recipient here being a CFO opening a consolidation pack.
 *
 * The fix is to prefix with an apostrophe, which Excel strips on display and
 * treats as "this is text". We do NOT strip the character: the value the user
 * typed is the value they get back, it simply cannot execute.
 */
export function escapeSpreadsheetValue(value: string): string {
  if (value.length === 0) return value;
  const first = value[0]!;
  if (first === '=' || first === '+' || first === '-' || first === '@'
    || first === '\t' || first === '\r') {
    return `'${value}`;
  }
  return value;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!)
    // XML 1.0 forbids most control characters outright; strip rather than emit
    // a document the recipient's parser will reject.
    // eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export type CellValue =
  | { kind: 'text'; value: string }
  /** Already a canonical decimal string from Money — never a JS number. */
  | { kind: 'number'; value: string };

export const text = (value: string): CellValue => ({ kind: 'text', value });
export const num = (value: string): CellValue => ({ kind: 'number', value });

export interface Sheet {
  name: string;
  rows: CellValue[][];
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const cellXml = cells
        .map((cell, colIndex) => {
          const ref = `${columnName(colIndex)}${r}`;
          if (cell.kind === 'number') {
            // Numeric cells cannot carry a formula, so no prefixing is needed —
            // but they must actually be numeric, which Money guarantees.
            return `<c r="${ref}"><v>${escapeXml(cell.value)}</v></c>`;
          }
          const safe = escapeXml(escapeSpreadsheetValue(cell.value));
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${safe}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cellXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows}</sheetData></worksheet>`;
}

/** Sheet names have their own forbidden set; an unescaped one corrupts the file. */
function safeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31);
  return cleaned.length > 0 ? cleaned : `Sheet${index + 1}`;
}

export function buildXlsx(sheets: readonly Sheet[]): Buffer {
  const named = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, i) }));

  const files: { path: string; content: Buffer }[] = [
    {
      path: '[Content_Types].xml',
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          named
            .map(
              (_, i) =>
                `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
            )
            .join('') +
          `</Types>`,
        'utf8',
      ),
    },
    {
      path: '_rels/.rels',
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    {
      path: 'xl/workbook.xml',
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
          named
            .map(
              (s, i) =>
                `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join('') +
          `</sheets></workbook>`,
        'utf8',
      ),
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          named
            .map(
              (_, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
            )
            .join('') +
          `</Relationships>`,
        'utf8',
      ),
    },
    ...named.map((sheet, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      content: Buffer.from(sheetXml(sheet), 'utf8'),
    })),
  ];

  return zip(files);
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: readonly { path: string; content: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(file.content, { level: 9 });
    const crc = crc32(file.content);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 filenames
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // time — fixed, for reproducible builds
    local.writeUInt16LE(0x21, 12);        // date — fixed (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // 42: relative offset of the local header for this entry
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, deflated);
    centrals.push(central);
    offset += local.length + deflated.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, end]);
}
