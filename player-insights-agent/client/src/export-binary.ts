import { inlinePlainText, type TableRow } from './answer-markdown';
import type { ExportTable } from './export-serializers';

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
type DrawOp =
  | { kind: 'text'; x: number; y: number; size: number; bold: boolean; text: string }
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

/** One page's content stream: text shown in `(...)` WinAnsi literals, images placed with `cm`/`Do`. */
function pageContentBytes(ops: readonly DrawOp[]): Uint8Array {
  const parts: (string | Uint8Array)[] = [];
  for (const op of ops) {
    if (op.kind === 'text') {
      parts.push(`BT /${op.bold ? 'F2' : 'F1'} ${op.size} Tf ${fmt(op.x)} ${fmt(op.y)} Td (`);
      parts.push(new Uint8Array(winAnsiStringBytes(op.text)));
      parts.push(') Tj ET\n');
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
