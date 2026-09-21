import { describe, expect, it } from 'vitest';
import { markdownPdf } from './export-binary';

/** A minimal but structurally valid baseline JPEG: SOI, an SOF0 frame stating 32×16, then EOI. */
function fakeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // length 17
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ]);
}

function jpegDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

async function pdfText(blob: Blob, encoding = 'utf-8'): Promise<string> {
  return new TextDecoder(encoding).decode(new Uint8Array(await blob.arrayBuffer()));
}

describe('PDF chart embedding', () => {
  it('embeds a chart JPEG as a DCTDecode image XObject and places it on the page', async () => {
    const dataUrl = jpegDataUrl(fakeJpeg(32, 16));
    const markdown = `## Answer\nPlayers rose.\n\n## Charts\n![Daily players](${dataUrl})\n`;
    const text = await pdfText(markdownPdf(markdown));
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 32');
    expect(text).toContain('/Height 16');
    // Referenced from the page resources and drawn with cm/Do.
    expect(text).toContain('/XObject << /Im0');
    expect(text).toMatch(/\/Im0 Do/);
    // The prose still renders as selectable text alongside the picture.
    expect(text).toContain('(Players rose.)');
  });

  it('drops an image it cannot embed rather than dumping base64 as text', async () => {
    const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
      markdown = `## Charts\n![PNG chart](${pngUrl})\n`;
    const text = await pdfText(markdownPdf(markdown));
    expect(text).not.toContain('iVBORw0KGgo');
    expect(text).not.toContain('/Image');
  });
});

describe('PDF WinAnsi text', () => {
  it('declares WinAnsi Helvetica and preserves accents, em dashes and curly quotes', async () => {
    const blob = markdownPdf('Caf\u00e9 \u2014 na\u00efve \u201cquote\u201d');
    const ascii = await pdfText(blob);
    expect(ascii).toContain('/Encoding /WinAnsiEncoding');
    // Decoded in the font's own encoding, the accented and typographic characters survive.
    const win1252 = await pdfText(blob, 'windows-1252');
    expect(win1252).toContain('Caf\u00e9');
    expect(win1252).toContain('\u2014'); // em dash, WinAnsi byte 0x97
    expect(win1252).toContain('na\u00efve');
    expect(win1252).toContain('\u201cquote\u201d');
  });
});
