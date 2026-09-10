import { inlinePlainText, type TableRow } from './answer-markdown';
import type { ExportTable } from './export-serializers';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 42;
const LINE_HEIGHT = 14;
const PDF_LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT);

interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  indent?: number;
  gapAfter?: number;
}

function pdfText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '?')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
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

function markdownPages(text: string): PdfLine[][] {
  const lines = text.split('\n').flatMap((line): PdfLine[] => {
    const readable = readableMarkdownLine(line);
    if (!readable) return [];
    const width = readable.indent ? 84 : 88;
    const wrappedLines = wrapText(readable.text, width);
    return wrappedLines.map((wrapped, index) => ({
      ...readable,
      text: wrapped,
      ...(index < wrappedLines.length - 1 ? { gapAfter: 0 } : {}),
    }));
  });
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let used = 0;
  for (const line of lines) {
    const units = (line.size ?? 10) > 14 ? 2 : 1;
    if (used + units > PDF_LINES_PER_PAGE && page.length) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += units;
  }
  if (page.length || pages.length === 0) pages.push(page);
  return pages.length ? pages : [[]];
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

/** Small dependency-free PDF writer. Text uses the built-in Helvetica font and remains selectable. */
function buildPdf(pages: readonly PdfLine[][]): Blob {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObject = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageObjects: number[] = [];
  for (const lines of pages) {
    const commands = ['BT', `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`];
    let previousIndent = 0;
    let previousGap = 0;
    lines.forEach((line, index) => {
      const size = line.size ?? 10;
      const indent = line.indent ?? 0;
      if (index) commands.push(`${indent - previousIndent} -${LINE_HEIGHT + previousGap} Td`);
      else if (indent) commands.push(`${indent} 0 Td`);
      commands.push(`/${line.bold ? 'F2' : 'F1'} ${size} Tf`, `(${pdfText(line.text)}) Tj`);
      previousIndent = indent;
      previousGap = line.gapAfter ?? 0;
    });
    commands.push('ET');
    const content = commands.join('\n');
    const contentObject = add(
      `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`
    );
    pageObjects.push(
      add(
        `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${font} 0 R /F2 ${boldFont} 0 R >> >> /Contents ${contentObject} 0 R >>`
      )
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] =
    `<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjects.length} >>`;

  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(output).length);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(output).length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([new TextEncoder().encode(output)], { type: 'application/pdf' });
}

export function markdownPdf(markdown: string): Blob {
  return buildPdf(markdownPages(markdown));
}

export function tablePdf(table: ExportTable): Blob {
  return buildPdf(tablePages(table));
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG generation failed.'))), 'image/png');
  });
}

/** Paints the table AST directly; it never reads or screenshots rendered DOM. */
export async function tablePng(table: ExportTable): Promise<Blob> {
  const rows = [table.block.header, ...table.block.rows].filter((row): row is TableRow => Boolean(row));
  const matrix = rows.map(tableCells);
  const columns = Math.max(1, ...matrix.map((row) => row.length));
  const cellWidth = 220;
  const lineHeight = 18;
  const padding = 10;
  const wrapped = matrix.map((row) => Array.from({ length: columns }, (_, column) => wrapText(row[column] ?? '', 30)));
  const rowHeights = wrapped.map((row) => Math.max(...row.map((cell) => cell.length)) * lineHeight + padding * 2);
  const sourceLines = table.sources.length
    ? wrapText(`Sources: ${table.sources.map((source) => source.name).join(', ')}`, Math.max(30, columns * 30))
    : [];
  const sourceHeight = sourceLines.length ? sourceLines.length * lineHeight + padding * 2 : 0;
  const tableHeight = rowHeights.reduce((sum, height) => sum + height, 0);
  const canvas = document.createElement('canvas');
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = columns * cellWidth * scale;
  canvas.height = (tableHeight + sourceHeight) * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG generation is unavailable in this browser.');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
  context.font = '13px system-ui, sans-serif';
  context.textBaseline = 'middle';
  let rowY = 0;
  wrapped.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex];
    row.forEach((lines, column) => {
      const x = column * cellWidth;
      context.fillStyle = rowIndex === 0 && table.block.header ? '#f1f5f9' : '#ffffff';
      context.fillRect(x, rowY, cellWidth, rowHeight);
      context.strokeStyle = '#cbd5e1';
      context.strokeRect(x, rowY, cellWidth, rowHeight);
      context.fillStyle = '#172033';
      context.font =
        rowIndex === 0 && table.block.header ? '600 13px system-ui, sans-serif' : '13px system-ui, sans-serif';
      lines.forEach((line, lineIndex) => {
        context.fillText(line, x + padding, rowY + padding + lineHeight * (lineIndex + 0.5), cellWidth - padding * 2);
      });
    });
    rowY += rowHeight;
  });
  if (sourceLines.length) {
    context.fillStyle = '#475569';
    context.font = '12px system-ui, sans-serif';
    sourceLines.forEach((line, index) => {
      context.fillText(
        line,
        padding,
        tableHeight + padding + lineHeight * (index + 0.5),
        columns * cellWidth - padding * 2
      );
    });
  }
  return canvasBlob(canvas);
}
