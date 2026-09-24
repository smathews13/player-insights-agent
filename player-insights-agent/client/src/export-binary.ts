import { inlinePlainText, type TableRow } from './answer-markdown';
import type { ExportTable } from './export-serializers';
import type { CostBriefPayload } from '../../shared/ops-contract';
import { opsRangeDates } from '../../shared/ops-contract';
import {
  buildDevProdProjection,
  costBriefExportView,
  PROD_VARIABLE_USAGE_FACTOR,
  type CostBriefExportView,
  type DevProdProjection,
} from './cost-brief-serializer';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 42;
const LINE_HEIGHT = 14;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const PDF_LINES_PER_PAGE = Math.floor(CONTENT_HEIGHT / LINE_HEIGHT);

interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  indent?: number;
  gapAfter?: number;
}

/**
 * Windows-1252 (WinAnsi) code points that live outside Latin-1's own 0xA0–0xFF range.
 *
 * WHY THIS TABLE EXISTS. The PDF's built-in Helvetica is declared
 * `/WinAnsiEncoding`, so a byte in a shown string is looked up in the WinAnsi
 * table -- which is Latin-1 for 0xA0–0xFF but fills 0x80–0x9F with the typographic
 * characters a real answer is full of: the em dash between a figure and its
 * comparison, the curly quotes a title picks up, the euro sign, the ellipsis a
 * truncation leaves. Latin-1 leaves those slots as control codes, so mapping a
 * curly quote to its Latin-1 code point would draw nothing. Mapping the handful
 * of common ones to their WinAnsi byte is the difference between "up 5%" reading
 * as written and reading as "up 5%?" with the dash eaten.
 */
const WINANSI_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

/** One character as its WinAnsi byte, or `?` (0x3F) for anything the built-in font cannot draw. */
function winAnsiByte(codePoint: number): number {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return WINANSI_HIGH.get(codePoint) ?? 0x3f;
}

/**
 * A show-string's bytes: WinAnsi-encoded, with the three characters that break a
 * PDF `(...)` literal -- backslash and the two parentheses -- backslash-escaped.
 *
 * NOT normalized with NFKD any more: NFKD splits `é` into `e` + a combining accent,
 * and the combining mark then has no WinAnsi byte and became `?`, so the old writer
 * turned every accented name into a mangled one. Mapping the precomposed code point
 * straight to its WinAnsi byte keeps `Café` as `Café`.
 */
function winAnsiStringBytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const byte = winAnsiByte(character.codePointAt(0) ?? 0x3f);
    if (byte === 0x5c || byte === 0x28 || byte === 0x29) bytes.push(0x5c);
    bytes.push(byte);
  }
  return bytes;
}

function wrapText(value: string, width: number): string[] {
  const words = value
    .trim()
    .split(/\s+/)
    .flatMap((word) => {
      const pieces: string[] = [];
      for (let at = 0; at < word.length; at += width) pieces.push(word.slice(at, at + width));
      return pieces;
    });
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function readableMarkdownLine(line: string): PdfLine | null {
  const trimmed = line.trim();
  if (/^```/.test(trimmed) || /^---+$/.test(trimmed)) return null;
  if (/^\|\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(trimmed)) return null;
  const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  const list = /^[-*+]\s+(.+)$/.exec(trimmed);
  const text = (heading?.[2] ?? list?.[1] ?? trimmed)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\|\s*|\s*\|$/g, '')
    .replace(/\s*\|\s*/g, '   |   ');
  if (!text) return { text: '', gapAfter: 4 };
  return {
    text: list ? `- ${text}` : text,
    ...(heading ? { size: heading[1].length === 1 ? 18 : 13, bold: true, gapAfter: 4 } : {}),
    ...(list ? { indent: 10 } : {}),
  };
}

/** One flowable unit of a document: a wrapped line of text, or a chart image to embed. */
type FlowItem = { kind: 'text'; line: PdfLine } | { kind: 'image'; dataUrl: string };

/** A whole markdown image line whose target is a data URL, e.g. `![Chart](data:image/jpeg;base64,…)`. */
const IMAGE_LINE = /^!\[[^\]]*\]\((data:image\/[^;]+;base64,[^)]+)\)$/;

/**
 * Markdown as an ordered flow of text lines and embeddable images.
 *
 * Images are pulled out BEFORE `readableMarkdownLine` sees the line, because that
 * helper turns `![alt](url)` into `alt (url)` -- which for a chart would dump a
 * quarter-megabyte of base64 into the page as text. Only a baseline JPEG data URL
 * becomes an image (DCTDecode is the only image filter this writer emits); any
 * other image markdown -- a PNG data URL, an http image -- is dropped rather than
 * printed, so a picture the PDF cannot embed leaves no garbage behind.
 */
function markdownFlow(text: string): FlowItem[] {
  const items: FlowItem[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (/^!\[[^\]]*\]\(/.test(trimmed)) {
      const image = IMAGE_LINE.exec(trimmed);
      if (image && image[1].startsWith('data:image/jpeg')) items.push({ kind: 'image', dataUrl: image[1] });
      continue;
    }
    const readable = readableMarkdownLine(raw);
    if (!readable) continue;
    const width = readable.indent ? 84 : 88;
    const wrapped = wrapText(readable.text, width);
    wrapped.forEach((line, index) =>
      items.push({
        kind: 'text',
        line: { ...readable, text: line, ...(index < wrapped.length - 1 ? { gapAfter: 0 } : {}) },
      })
    );
  }
  return items;
}

function tableCells(row: TableRow): string[] {
  return row.cells.map((cell) => inlinePlainText(cell.children).replace(/\s+/g, ' ').trim());
}

function wrappedTableRow(row: string[], width: number, columns: number, bold = false): PdfLine[] {
  const cells = Array.from({ length: columns }, (_, index) => wrapText(row[index] ?? '', width));
  const height = Math.max(1, ...cells.map((cell) => cell.length));
  return Array.from({ length: height }, (_, line) => ({
    text: cells
      .map((cell) => (cell[line] ?? '').padEnd(width))
      .join(' | ')
      .trimEnd(),
    bold,
  }));
}

function tablePages(table: ExportTable): PdfLine[][] {
  const rows = table.block.rows.map(tableCells);
  const header = table.block.header ? tableCells(table.block.header) : [];
  const columns = Math.max(header.length, ...rows.map((row) => row.length));
  const width = Math.max(8, Math.floor(82 / Math.max(1, columns)));
  const sourceLine = table.sources.length ? `Sources: ${table.sources.map((source) => source.name).join(', ')}` : '';
  const repeated = header.length ? wrappedTableRow(header, width, columns, true) : [];
  const pages: PdfLine[][] = [];
  let page = [...repeated];
  for (const row of rows) {
    const wrapped = wrappedTableRow(row, width, columns);
    if (page.length > repeated.length && page.length + wrapped.length > PDF_LINES_PER_PAGE) {
      pages.push(page);
      page = [...repeated];
    }
    // A single very tall row continues on following pages without losing text.
    for (const line of wrapped) {
      if (page.length >= PDF_LINES_PER_PAGE) {
        pages.push(page);
        page = [...repeated];
      }
      page.push(line);
    }
  }
  if (sourceLine) {
    const source = wrapText(sourceLine, 88).map((text) => ({ text, size: 9 }) satisfies PdfLine);
    for (const line of [{ text: '' }, ...source]) {
      if (page.length >= PDF_LINES_PER_PAGE) {
        pages.push(page);
        page = [];
      }
      page.push(line);
    }
  }
  if (page.length || pages.length === 0) pages.push(page);
  return pages;
}

/* ── Byte-level PDF assembler ─────────────────────────────────────────────────── */

/** A drawing instruction with page coordinates already resolved (PDF's origin is bottom-left). */
type PdfColor = readonly [number, number, number];

type DrawOp =
  | { kind: 'text'; x: number; y: number; size: number; bold: boolean; text: string; color?: PdfColor }
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: PdfColor;
      stroke?: PdfColor;
      lineWidth?: number;
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: PdfColor; lineWidth?: number }
  | { kind: 'image'; x: number; y: number; w: number; h: number; image: number };

/** A decoded baseline JPEG ready to embed as a DCTDecode image XObject. */
interface PdfImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

const ENCODER = new TextEncoder();

function concatBytes(parts: readonly (string | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((part) => (typeof part === 'string' ? ENCODER.encode(part) : part));
  const total = encoded.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of encoded) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A PDF number: integers plain, fractions to two places (enough for placement, and it keeps streams small). */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The raw bytes behind a `data:...;base64,...` URL. */
function dataUrlBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * A JPEG's pixel dimensions, read from its frame header, or null if it is not one.
 *
 * The PDF image XObject has to declare the picture's width and height, and the only
 * place they are stated is the SOF (start-of-frame) marker. The scan walks the
 * marker segments -- skipping the parameterless standalone markers, stepping over
 * every other by its length -- until it reaches a frame header and reads the two
 * 16-bit fields. A non-JPEG (no SOI, no frame) returns null and the image is dropped.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    // SOI, EOI, the eight restart markers and TEM carry no length or payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // Any SOFn (0xC0–0xCF) except the non-frame DHT/JPG/DAC markers states the size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  return null;
}

/** A text line's vertical footprint, including its trailing gap. */
function textLineHeight(line: PdfLine): number {
  return Math.max(LINE_HEIGHT, (line.size ?? 10) + 2) + (line.gapAfter ?? 0);
}

/** A chart drawn to the content width, shrunk to fit a page when its aspect ratio is tall. */
function imageDrawSize(image: PdfImage): { w: number; h: number } {
  const ratio = image.height / image.width;
  if (CONTENT_WIDTH * ratio > CONTENT_HEIGHT) return { w: CONTENT_HEIGHT / ratio, h: CONTENT_HEIGHT };
  return { w: CONTENT_WIDTH, h: CONTENT_WIDTH * ratio };
}

/**
 * Lay out a flow of text and images into pages, decoding each image once.
 *
 * A top-origin cursor walks down the page; an item that would cross the bottom
 * margin starts a fresh page. Coordinates are converted to PDF's bottom-left
 * origin here so the assembler stays a dumb writer. Images are decoded and sized
 * at layout time and referenced by index, so the same picture is embedded once.
 */
function paginateFlow(items: readonly FlowItem[]): { pages: DrawOp[][]; images: PdfImage[] } {
  const images: PdfImage[] = [];
  const pages: DrawOp[][] = [];
  let page: DrawOp[] = [];
  let top = MARGIN;
  const flush = () => {
    pages.push(page);
    page = [];
    top = MARGIN;
  };
  for (const item of items) {
    if (item.kind === 'text') {
      const size = item.line.size ?? 10;
      if (PAGE_HEIGHT - top - size < MARGIN && page.length) flush();
      page.push({
        kind: 'text',
        x: MARGIN + (item.line.indent ?? 0),
        y: PAGE_HEIGHT - top - size,
        size,
        bold: Boolean(item.line.bold),
        text: item.line.text,
      });
      top += textLineHeight(item.line);
      continue;
    }
    const bytes = dataUrlBytes(item.dataUrl);
    const size = jpegSize(bytes);
    if (!size || size.width === 0 || size.height === 0) continue;
    const index = images.push({ bytes, width: size.width, height: size.height }) - 1;
    const draw = imageDrawSize(images[index]);
    if (PAGE_HEIGHT - top - draw.h < MARGIN && page.length) flush();
    page.push({ kind: 'image', x: MARGIN, y: PAGE_HEIGHT - top - draw.h, w: draw.w, h: draw.h, image: index });
    top += draw.h + 8;
  }
  if (page.length || pages.length === 0) pages.push(page);
  return { pages, images };
}

/** Pre-paginated text lines (the table path) as text draw ops, positioned from the top of each page. */
function linesToDrawPages(pages: readonly PdfLine[][]): DrawOp[][] {
  return pages.map((lines) => {
    const ops: DrawOp[] = [];
    let top = MARGIN;
    for (const line of lines) {
      const size = line.size ?? 10;
      ops.push({
        kind: 'text',
        x: MARGIN + (line.indent ?? 0),
        y: PAGE_HEIGHT - top - size,
        size,
        bold: Boolean(line.bold),
        text: line.text,
      });
      top += textLineHeight(line);
    }
    return ops;
  });
}

function pdfColor(color: PdfColor): string {
  return color.map((channel) => fmt(channel)).join(' ');
}

/** One page's content stream: selectable text plus vector layout and embedded images. */
function pageContentBytes(ops: readonly DrawOp[]): Uint8Array {
  const parts: (string | Uint8Array)[] = [];
  for (const op of ops) {
    if (op.kind === 'text') {
      const color = op.color ? `${pdfColor(op.color)} rg ` : '';
      parts.push(`${color}BT /${op.bold ? 'F2' : 'F1'} ${op.size} Tf ${fmt(op.x)} ${fmt(op.y)} Td (`);
      parts.push(new Uint8Array(winAnsiStringBytes(op.text)));
      parts.push(') Tj ET\n');
    } else if (op.kind === 'rect') {
      const paint = op.fill && op.stroke ? 'B' : op.fill ? 'f' : 'S';
      parts.push(
        `q ${op.fill ? `${pdfColor(op.fill)} rg ` : ''}${op.stroke ? `${pdfColor(op.stroke)} RG ` : ''}${
          op.lineWidth ? `${fmt(op.lineWidth)} w ` : ''
        }${fmt(op.x)} ${fmt(op.y)} ${fmt(op.w)} ${fmt(op.h)} re ${paint} Q\n`
      );
    } else if (op.kind === 'line') {
      parts.push(
        `q ${pdfColor(op.color)} RG ${fmt(op.lineWidth ?? 1)} w ${fmt(op.x1)} ${fmt(op.y1)} m ${fmt(op.x2)} ${fmt(
          op.y2
        )} l S Q\n`
      );
    } else {
      parts.push(`q ${fmt(op.w)} 0 0 ${fmt(op.h)} ${fmt(op.x)} ${fmt(op.y)} cm /Im${op.image} Do Q\n`);
    }
  }
  return concatBytes(parts);
}

/**
 * Dependency-free PDF writer. Text is selectable WinAnsi Helvetica; charts are
 * embedded as DCTDecode (baseline JPEG) image XObjects.
 */
function assemblePdf(pages: readonly DrawOp[][], images: readonly PdfImage[]): Blob {
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array): number => {
    objects.push(typeof body === 'string' ? ENCODER.encode(body) : body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObject = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const imageObjects = images.map((image) =>
    add(
      concatBytes([
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`,
        image.bytes,
        '\nendstream',
      ])
    )
  );
  const pageObjects: number[] = [];
  for (const ops of pages) {
    const content = pageContentBytes(ops);
    const contentObject = add(concatBytes([`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']));
    const usedImages = [...new Set(ops.flatMap((op) => (op.kind === 'image' ? [op.image] : [])))];
    const xobjects = usedImages.length
      ? ` /XObject << ${usedImages.map((index) => `/Im${index} ${imageObjects[index]} 0 R`).join(' ')} >>`
      : '';
    pageObjects.push(
      add(
        `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${font} 0 R /F2 ${boldFont} 0 R >>${xobjects} >> /Contents ${contentObject} 0 R >>`
      )
    );
  }
  objects[catalog - 1] = ENCODER.encode(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  objects[pagesObject - 1] = ENCODER.encode(
    `<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjects.length} >>`
  );

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? ENCODER.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  // "%PDF-1.4" then a comment line of high bytes that marks the file binary.
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    push(`${index + 1} 0 obj\n`);
    push(object);
    push('\nendobj\n');
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  push(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''));
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob([concatBytes(chunks)], { type: 'application/pdf' });
}

/** Small dependency-free PDF writer for pre-paginated text (the table path). */
function buildPdf(pages: readonly PdfLine[][]): Blob {
  return assemblePdf(linesToDrawPages(pages), []);
}

export function markdownPdf(markdown: string): Blob {
  const { pages, images } = paginateFlow(markdownFlow(markdown));
  return assemblePdf(pages, images);
}

export type CostBriefPdfMode = 'observed' | 'dev-prod-projection';

// The cost report intentionally uses the app's dark presentation palette. Keep
// both observed and projection exports on this one visual system.
const INK: PdfColor = [0.95, 0.97, 0.98];
const MUTED: PdfColor = [0.59, 0.63, 0.68];
const RULE: PdfColor = [0.2, 0.24, 0.27];
const BACKGROUND: PdfColor = [0.07, 0.09, 0.11];
const PANEL: PdfColor = [0.1, 0.12, 0.14];
const PANEL_HEADER: PdfColor = [0.12, 0.15, 0.17];
const BLUE: PdfColor = [0.13, 0.45, 0.71];
const BLUE_LIGHT: PdfColor = [0.08, 0.58, 0.55];
const GREEN: PdfColor = [0.08, 0.62, 0.48];

function costText(
  page: DrawOp[],
  text: string,
  x: number,
  y: number,
  size = 10,
  bold = false,
  color: PdfColor = INK
): void {
  page.push({ kind: 'text', x, y, size, bold, text, color });
}

function costMoney(amount: number | null | undefined, currency: string, projection = false): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'Unavailable';
  const value = amount.toLocaleString('en-US', {
    minimumFractionDigits: projection ? 0 : 2,
    maximumFractionDigits: projection ? 0 : 2,
  });
  return currency ? `${value} ${currency}` : value;
}

function costDays(brief: CostBriefPayload): number {
  const from = Date.parse(`${brief.range.from}T00:00:00Z`);
  const to = Date.parse(`${brief.range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / 86_400_000) + 1 : 0;
}

function costCard(page: DrawOp[], x: number, label: string, value: string, note: string): void {
  const money = /^(.*)\s(USD|DBU|EUR|GBP|CAD|AUD|JPY)$/.exec(value);
  page.push({ kind: 'rect', x, y: 538, w: 166, h: 90, fill: PANEL, stroke: RULE, lineWidth: 0.6 });
  costText(page, label.toUpperCase(), x + 12, 607, 8, true, MUTED);
  costText(page, money?.[1] ?? value, x + 12, 578, 19, true);
  if (money?.[2]) costText(page, money[2], x + 12, 558, 8, false, MUTED);
  costText(page, note, x + 12, 544, 8, false, MUTED);
}

function costMark(page: DrawOp[]): void {
  const squares = [
    [52, 714],
    [52, 723],
    [52, 705],
    [43, 714],
    [61, 714],
  ] as const;
  for (const [x, y] of squares) {
    page.push({ kind: 'rect', x, y, w: 9, h: 9, fill: INK });
  }
  page.push({ kind: 'rect', x: 55, y: 717, w: 3, h: 3, fill: BLUE });
}

function projectionCards(page: DrawOp[], brief: CostBriefPayload, projection: DevProdProjection): void {
  costCard(
    page,
    42,
    'Observed Dev',
    costMoney(projection.devObserved, brief.currency),
    'Billing-derived · last 31 days'
  );
  costCard(
    page,
    223,
    'Projected Prod',
    costMoney(projection.prodProjected, brief.currency, true),
    'Projection · rounded'
  );
  costCard(
    page,
    404,
    'Combined total',
    costMoney(projection.combined, brief.currency, true),
    'Dev observed + Prod projected'
  );

  const dev = projection.devObserved ?? 0;
  const prod = projection.prodProjected ?? 0;
  const total = dev + prod;
  const devWidth = total > 0 ? 528 * (dev / total) : 0;
  page.push({ kind: 'rect', x: 42, y: 526, w: 528, h: 8, fill: PANEL });
  if (devWidth > 0) page.push({ kind: 'rect', x: 42, y: 526, w: devWidth, h: 8, fill: BLUE });
  if (total > 0) page.push({ kind: 'rect', x: 42 + devWidth, y: 526, w: 528 - devWidth, h: 8, fill: GREEN });
  page.push({ kind: 'rect', x: 42, y: 509, w: 7, h: 7, fill: BLUE });
  costText(page, 'Observed Dev', 54, 508, 8, false, MUTED);
  page.push({ kind: 'rect', x: 137, y: 509, w: 7, h: 7, fill: GREEN });
  costText(page, 'Projected Prod', 149, 508, 8, false, MUTED);
}

function observedCards(page: DrawOp[], brief: CostBriefPayload, exported: CostBriefExportView): void {
  costCard(page, 42, 'Total', costMoney(exported.total, brief.currency), 'Observed billing · estimated');
  costCard(
    page,
    223,
    'Attributed to questions',
    costMoney(exported.attributed, brief.currency),
    'Question-driven usage'
  );
  costCard(page, 404, 'Standing infrastructure', costMoney(exported.standing, brief.currency), 'Fixed idle remainder');

  const attributed = exported.attributed ?? 0;
  const standing = exported.standing ?? 0;
  const total = attributed + standing;
  const attributedWidth = total > 0 ? 528 * (attributed / total) : 0;
  page.push({ kind: 'rect', x: 42, y: 526, w: 528, h: 8, fill: PANEL });
  if (attributedWidth > 0) page.push({ kind: 'rect', x: 42, y: 526, w: attributedWidth, h: 8, fill: BLUE });
  if (total > 0)
    page.push({ kind: 'rect', x: 42 + attributedWidth, y: 526, w: 528 - attributedWidth, h: 8, fill: GREEN });
  page.push({ kind: 'rect', x: 42, y: 509, w: 7, h: 7, fill: BLUE });
  costText(page, 'Attributed to questions', 54, 508, 8, false, MUTED);
  page.push({ kind: 'rect', x: 172, y: 509, w: 7, h: 7, fill: GREEN, stroke: RULE, lineWidth: 0.3 });
  costText(page, 'Standing infrastructure', 184, 508, 8, false, MUTED);
}

function observedResourceTable(page: DrawOp[], brief: CostBriefPayload, exported: CostBriefExportView): number {
  costText(page, 'BY RESOURCE', 42, 476, 9, true, BLUE);
  const tableBottom = 428 - exported.resources.length * 28 - 18;
  page.push({
    kind: 'rect',
    x: 42,
    y: tableBottom,
    w: 528,
    h: 470 - tableBottom,
    fill: PANEL,
    stroke: RULE,
    lineWidth: 0.6,
  });
  page.push({ kind: 'rect', x: 42, y: 446, w: 528, h: 24, fill: PANEL_HEADER });
  costText(page, 'RESOURCE', 42, 454, 8, true, MUTED);
  costText(page, 'SHARE', 220, 454, 8, true, MUTED);
  costText(page, 'SPEND', 478, 454, 8, true, MUTED);
  page.push({ kind: 'line', x1: 42, y1: 446, x2: 570, y2: 446, color: RULE, lineWidth: 0.8 });
  let y = 428;
  const total = exported.total;
  for (const [index, resource] of exported.resources.entries()) {
    const shareValue =
      typeof resource.amount === 'number' && typeof total === 'number' && total > 0 ? resource.amount / total : null;
    const share = shareValue === null ? '—' : `${(shareValue * 100).toFixed(1)}%`;
    costText(page, resource.label, 42, y, 9, false);
    page.push({ kind: 'rect', x: 220, y: y + 1, w: 170, h: 5, fill: RULE });
    if (shareValue !== null && shareValue > 0) {
      page.push({
        kind: 'rect',
        x: 220,
        y: y + 1,
        w: Math.max(1, 170 * shareValue),
        h: 5,
        fill: index === 0 ? BLUE : BLUE_LIGHT,
      });
    }
    costText(page, share, 402, y, 9, false, MUTED);
    costText(page, costMoney(resource.amount, brief.currency), 478, y, 9, false);
    page.push({ kind: 'line', x1: 42, y1: y - 10, x2: 570, y2: y - 10, color: RULE, lineWidth: 0.4 });
    y -= 28;
  }
  costText(page, 'Total', 42, y, 9, true);
  costText(page, costMoney(exported.total, brief.currency), 478, y, 9, true);
  return y;
}

function projectionResourceTable(page: DrawOp[], brief: CostBriefPayload, projection: DevProdProjection): number {
  costText(page, 'BY RESOURCE', 42, 476, 9, true, BLUE);
  const tableBottom = 428 - projection.resources.length * 28 - 18;
  page.push({
    kind: 'rect',
    x: 42,
    y: tableBottom,
    w: 528,
    h: 470 - tableBottom,
    fill: PANEL,
    stroke: RULE,
    lineWidth: 0.6,
  });
  page.push({ kind: 'rect', x: 42, y: 446, w: 528, h: 24, fill: PANEL_HEADER });
  costText(page, 'RESOURCE', 42, 454, 8, true, MUTED);
  costText(page, 'DEV OBSERVED', 286, 454, 8, true, MUTED);
  costText(page, 'PROD PROJECTED', 390, 454, 8, true, MUTED);
  costText(page, 'COMBINED', 500, 454, 8, true, MUTED);
  page.push({ kind: 'line', x1: 42, y1: 446, x2: 570, y2: 446, color: RULE, lineWidth: 0.8 });
  let y = 428;
  for (const resource of projection.resources) {
    costText(page, resource.label, 42, y, 9, false);
    costText(page, costMoney(resource.devObserved, brief.currency), 286, y, 8, false);
    costText(page, costMoney(resource.prodProjected, brief.currency, true), 390, y, 8, false, GREEN);
    costText(page, costMoney(resource.combined, brief.currency, true), 500, y, 8, true);
    page.push({ kind: 'line', x1: 42, y1: y - 10, x2: 570, y2: y - 10, color: RULE, lineWidth: 0.4 });
    y -= 28;
  }
  costText(page, 'Total', 42, y, 9, true);
  costText(page, costMoney(projection.devObserved, brief.currency), 286, y, 8, true);
  costText(page, costMoney(projection.prodProjected, brief.currency, true), 390, y, 8, true, GREEN);
  costText(page, costMoney(projection.combined, brief.currency, true), 500, y, 8, true);
  return y;
}

function costPageHeader(page: DrawOp[], brief: CostBriefPayload, eyebrow: string, title: string): void {
  const days = costDays(brief);
  const window = opsRangeDates(brief.range);
  page.push({ kind: 'rect', x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT, fill: BACKGROUND });
  costMark(page);
  costText(page, eyebrow, 86, 728, 9, true, BLUE_LIGHT);
  costText(page, title, 86, 693, 24, true);
  costText(page, 'Player Insights · Databricks App', 86, 673, 11, false, MUTED);
  costText(page, `Window ${window}${days ? ` · ${days} complete days` : ''}`, 350, 693, 8, false, MUTED);
  costText(page, `Generated ${brief.generatedAt}`, 350, 678, 8, false, MUTED);
  page.push({ kind: 'line', x1: 42, y1: 654, x2: 570, y2: 654, color: RULE, lineWidth: 0.8 });
}

function costPageFooter(page: DrawOp[], left: string, right: string): void {
  page.push({ kind: 'line', x1: 42, y1: 55, x2: 570, y2: 55, color: RULE, lineWidth: 0.6 });
  costText(page, left, 42, 38, 8, false, MUTED);
  costText(page, right, 345, 38, 8, false, MUTED);
}

function prodProjectionCards(page: DrawOp[], brief: CostBriefPayload, projection: DevProdProjection): void {
  const fixed = projection.devStanding;
  const variable = projection.devVariable === null ? null : projection.devVariable * projection.variableUsageFactor;
  costCard(page, 42, 'Projected Prod', costMoney(projection.prodProjected, brief.currency, true), 'Modeled total');
  costCard(page, 223, 'Fixed hosting input', costMoney(fixed, brief.currency, true), '100% of Dev standing');
  costCard(page, 404, 'Usage input', costMoney(variable, brief.currency, true), '15% of Dev variable');

  const fixedValue = fixed ?? 0;
  const variableValue = variable ?? 0;
  const total = fixedValue + variableValue;
  const fixedWidth = total > 0 ? 528 * (fixedValue / total) : 0;
  page.push({ kind: 'rect', x: 42, y: 526, w: 528, h: 8, fill: PANEL });
  if (fixedWidth > 0) page.push({ kind: 'rect', x: 42, y: 526, w: fixedWidth, h: 8, fill: BLUE });
  if (total > 0) page.push({ kind: 'rect', x: 42 + fixedWidth, y: 526, w: 528 - fixedWidth, h: 8, fill: GREEN });
  page.push({ kind: 'rect', x: 42, y: 509, w: 7, h: 7, fill: BLUE });
  costText(page, 'Fixed hosting', 54, 508, 8, false, MUTED);
  page.push({ kind: 'rect', x: 137, y: 509, w: 7, h: 7, fill: GREEN });
  costText(page, 'Question-driven usage', 149, 508, 8, false, MUTED);
}

function prodProjectionResourceTable(page: DrawOp[], brief: CostBriefPayload, projection: DevProdProjection): number {
  costText(page, 'PROD INPUTS BY RESOURCE', 42, 476, 9, true, BLUE);
  const tableBottom = 428 - projection.resources.length * 28 - 18;
  page.push({
    kind: 'rect',
    x: 42,
    y: tableBottom,
    w: 528,
    h: 470 - tableBottom,
    fill: PANEL,
    stroke: RULE,
    lineWidth: 0.6,
  });
  page.push({ kind: 'rect', x: 42, y: 446, w: 528, h: 24, fill: PANEL_HEADER });
  costText(page, 'RESOURCE', 42, 454, 8, true, MUTED);
  costText(page, 'FIXED INPUT', 286, 454, 8, true, MUTED);
  costText(page, 'USAGE INPUT', 390, 454, 8, true, MUTED);
  costText(page, 'PROD PROJECTED', 500, 454, 8, true, MUTED);
  page.push({ kind: 'line', x1: 42, y1: 446, x2: 570, y2: 446, color: RULE, lineWidth: 0.8 });
  let y = 428;
  for (const resource of projection.resources) {
    costText(page, resource.label, 42, y, 9, false);
    costText(page, costMoney(resource.prodStanding, brief.currency, true), 286, y, 8, false);
    costText(page, costMoney(resource.prodVariable, brief.currency, true), 390, y, 8, false, GREEN);
    costText(page, costMoney(resource.prodProjected, brief.currency, true), 500, y, 8, true);
    page.push({ kind: 'line', x1: 42, y1: y - 10, x2: 570, y2: y - 10, color: RULE, lineWidth: 0.4 });
    y -= 28;
  }
  costText(page, 'Total', 42, y, 9, true);
  costText(page, costMoney(projection.devStanding, brief.currency, true), 286, y, 8, true);
  const variable = projection.devVariable === null ? null : projection.devVariable * projection.variableUsageFactor;
  costText(page, costMoney(variable, brief.currency, true), 390, y, 8, true, GREEN);
  costText(page, costMoney(projection.prodProjected, brief.currency, true), 500, y, 8, true);
  return y;
}

function devProdProjectionPages(brief: CostBriefPayload, projection: DevProdProjection): DrawOp[][] {
  const exported = costBriefExportView(brief);
  const dev: DrawOp[] = [];
  costPageHeader(dev, brief, 'DEV + PROD PROJECTION · PAGE 1 OF 2', 'Development observed');
  costText(dev, 'DEVELOPMENT · OBSERVED', 42, 638, 9, true, BLUE);
  observedCards(dev, brief, exported);
  observedResourceTable(dev, brief, exported);
  costPageFooter(dev, 'Player Insights Agent · Development observed', 'Billing-derived Dev spend · Page 1 of 2');

  const prod: DrawOp[] = [];
  costPageHeader(prod, brief, 'DEV + PROD PROJECTION · PAGE 2 OF 2', 'Production projection');
  costText(prod, 'PRODUCTION · PROJECTED', 42, 638, 9, true, BLUE);
  prodProjectionCards(prod, brief, projection);
  const tableEnd = prodProjectionResourceTable(prod, brief, projection);
  const boxY = Math.max(72, tableEnd - 88);
  prod.push({ kind: 'rect', x: 42, y: boxY, w: 528, h: 70, fill: PANEL, stroke: RULE, lineWidth: 0.6 });
  costText(prod, 'PROJECTION ASSUMPTIONS · NOT ACTUAL SPEND', 54, boxY + 52, 8, true, GREEN);
  costText(prod, 'Fixed hosting input: 100% of reconciled Dev standing spend.', 54, boxY + 35, 8, false);
  costText(
    prod,
    `Usage input: ${Math.round(PROD_VARIABLE_USAGE_FACTOR * 100)}% of reconciled Dev question-driven spend.`,
    54,
    boxY + 21,
    8,
    false
  );
  costText(prod, 'Projected figures are displayed to the nearest currency unit.', 54, boxY + 7, 8, false, MUTED);
  costPageFooter(
    prod,
    'Player Insights Agent · Production projection',
    'Modeled inputs, not actual spend · Page 2 of 2'
  );
  return [dev, prod];
}

/**
 * Branded, one-page cost report matching the supplied reference's hierarchy:
 * title and window, three spend cards, a comparison bar, resource table, and
 * restrained footer. The projection variant keeps that layout but labels every
 * modeled Prod number as projected and prints its assumptions in the document.
 */
export function costBriefPdf(brief: CostBriefPayload, mode: CostBriefPdfMode = 'observed'): Blob {
  const exported = costBriefExportView(brief);
  const projection = mode === 'dev-prod-projection' ? buildDevProdProjection(brief) : null;
  if (projection && brief.state === 'ready') return assemblePdf(devProdProjectionPages(brief, projection), []);
  const page: DrawOp[] = [];
  const days = costDays(brief);
  const window = opsRangeDates(brief.range);

  page.push({ kind: 'rect', x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT, fill: BACKGROUND });
  costMark(page);
  costText(page, projection ? 'DEV + PROD PROJECTION' : 'COST BREAKDOWN', 86, 728, 9, true, BLUE_LIGHT);
  costText(page, projection ? 'Dev + Prod projection' : 'Trailing 31 days', 86, 693, 24, true);
  costText(page, 'Player Insights · Databricks App', 86, 673, 11, false, MUTED);
  costText(page, `Window ${window}${days ? ` · ${days} complete days` : ''}`, 350, 693, 8, false, MUTED);
  costText(page, `Generated ${brief.generatedAt}`, 350, 678, 8, false, MUTED);
  page.push({ kind: 'line', x1: 42, y1: 654, x2: 570, y2: 654, color: RULE, lineWidth: 0.8 });

  if (brief.state !== 'ready') {
    costText(page, 'SPEND COULD NOT BE ESTABLISHED', 42, 620, 9, true, BLUE);
    wrapText(brief.reason || 'No spend could be established for this window.', 82).forEach((line, index) =>
      costText(page, line, 42, 590 - index * 16, 10, false, MUTED)
    );
  } else {
    costText(page, projection ? 'PLANNING SCENARIO' : 'SPEND', 42, 638, 9, true, BLUE);
    if (projection) {
      projectionCards(page, brief, projection);
      const tableEnd = projectionResourceTable(page, brief, projection);
      const boxY = Math.max(72, tableEnd - 88);
      page.push({ kind: 'rect', x: 42, y: boxY, w: 528, h: 70, fill: PANEL, stroke: RULE, lineWidth: 0.6 });
      costText(page, 'PROJECTION ASSUMPTIONS · NOT ACTUAL SPEND', 54, boxY + 52, 8, true, GREEN);
      costText(page, 'Prod fixed hosting: 100% of each applicable Dev standing-cost share.', 54, boxY + 35, 8, false);
      costText(
        page,
        `Prod question-driven usage: ${Math.round(PROD_VARIABLE_USAGE_FACTOR * 100)}% of observed Dev variable usage.`,
        54,
        boxY + 21,
        8,
        false
      );
      costText(page, 'Projected figures are displayed to the nearest currency unit.', 54, boxY + 7, 8, false, MUTED);
    } else {
      observedCards(page, brief, exported);
      observedResourceTable(page, brief, exported);
    }
  }

  page.push({ kind: 'line', x1: 42, y1: 55, x2: 570, y2: 55, color: RULE, lineWidth: 0.6 });
  costText(
    page,
    projection ? 'Player Insights Agent · Dev + Prod projection' : 'Player Insights Agent · Cost breakdown',
    42,
    38,
    8,
    false,
    MUTED
  );
  costText(
    page,
    projection
      ? 'Observed Dev + modeled Prod · Projection, not actual spend'
      : 'Spend shown in billing currency · Estimated',
    345,
    38,
    8,
    false,
    MUTED
  );
  return assemblePdf([page], []);
}

export function tablePdf(table: ExportTable): Blob {
  return buildPdf(tablePages(table));
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG generation failed.'))), 'image/png');
  });
}

export function wrappedCanvasLines(value: string, width: number, measure: (text: string) => number): string[] {
  if (!value) return [''];
  const lines: string[] = [];
  let line = '';
  for (const character of value) {
    const next = `${line}${character}`;
    if (line && measure(next) > width) {
      lines.push(line);
      line = character;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_AREA = 64_000_000;
const PREFERRED_CELL_WIDTH = 190;
const MIN_CELL_WIDTH = 96;
const PNG_PADDING = 12;
const PNG_LINE_HEIGHT = 20;

export interface TablePngLayout {
  width: number;
  height: number;
  cellWidth: number;
  sourceLines: string[];
  rowLines: string[][][];
  rowHeights: number[];
  sourceHeight: number;
}

export function tablePngLayout(table: ExportTable, measure: (text: string) => number): TablePngLayout {
  const rows = [table.block.header, ...table.block.rows].filter((row): row is TableRow => Boolean(row)).map(tableCells);
  const columns = Math.max(1, ...rows.map((row) => row.length));
  if (columns * MIN_CELL_WIDTH > MAX_CANVAS_DIMENSION) {
    throw new Error('This table is too wide for a PNG. Copy TSV or download PDF to preserve every column.');
  }
  const cellWidth = Math.min(PREFERRED_CELL_WIDTH, Math.floor(MAX_CANVAS_DIMENSION / columns));
  const width = columns * cellWidth;
  const sourceText = table.sources.length ? `Sources: ${table.sources.map((source) => source.name).join(', ')}` : '';
  const sourceLines = sourceText ? wrappedCanvasLines(sourceText, width - PNG_PADDING * 2, measure) : [];
  const sourceHeight = sourceLines.length ? sourceLines.length * PNG_LINE_HEIGHT + PNG_PADDING * 2 : 0;
  const rowLines = rows.map((row) =>
    Array.from({ length: columns }, (_, index) =>
      wrappedCanvasLines(row[index] ?? '', cellWidth - PNG_PADDING * 2, measure)
    )
  );
  const rowHeights = rowLines.map(
    (row) => Math.max(...row.map((lines) => lines.length), 1) * PNG_LINE_HEIGHT + PNG_PADDING * 2
  );
  const height = sourceHeight + rowHeights.reduce((sum, value) => sum + value, 0);
  if (height > MAX_CANVAS_DIMENSION || width * height > MAX_CANVAS_AREA) {
    throw new Error('This table is too large for a PNG. Copy TSV or download PDF to preserve every row.');
  }
  return { width, height, cellWidth, sourceLines, rowLines, rowHeights, sourceHeight };
}

/** Paints the table AST directly; it never reads or screenshots rendered DOM. */
export async function tablePng(table: ExportTable): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG generation is unavailable in this browser.');
  context.font = '13px system-ui, sans-serif';
  const layout = tablePngLayout(table, (text) => context.measureText(text).width);
  canvas.width = layout.width;
  canvas.height = layout.height;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '13px system-ui, sans-serif';
  context.textBaseline = 'middle';
  layout.sourceLines.forEach((line, index) => {
    context.fillStyle = '#475569';
    context.font = '12px system-ui, sans-serif';
    context.fillText(line, PNG_PADDING, PNG_PADDING + PNG_LINE_HEIGHT * (index + 0.5));
  });
  let rowY = layout.sourceHeight;
  layout.rowLines.forEach((row, rowIndex) => {
    const rowHeight = layout.rowHeights[rowIndex];
    row.forEach((lines, column) => {
      const x = column * layout.cellWidth;
      context.fillStyle = rowIndex === 0 && table.block.header ? '#f1f5f9' : '#ffffff';
      context.fillRect(x, rowY, layout.cellWidth, rowHeight);
      context.strokeStyle = '#cbd5e1';
      context.strokeRect(x, rowY, layout.cellWidth, rowHeight);
      context.fillStyle = '#172033';
      context.font =
        rowIndex === 0 && table.block.header ? '600 13px system-ui, sans-serif' : '13px system-ui, sans-serif';
      lines.forEach((line, lineIndex) => {
        context.fillText(line, x + PNG_PADDING, rowY + PNG_PADDING + PNG_LINE_HEIGHT * (lineIndex + 0.5));
      });
    });
    rowY += rowHeight;
  });
  return canvasBlob(canvas);
}
