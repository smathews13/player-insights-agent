import { describe, expect, it } from 'vitest';
import type { AppSpendFigure, CostBriefPayload } from '../../shared/ops-contract';
import { costBriefPdf, markdownPdf } from './export-binary';

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

function spend(amount: number): AppSpendFigure {
  return {
    amount,
    dbus: null,
    currency: 'USD',
    sourceFrom: '2026-07-18',
    sourceThrough: '2026-08-17',
    completeness: 'complete',
    estimated: true,
  };
}

const costBrief: CostBriefPayload = {
  period: 'trailing_31d',
  state: 'ready',
  grant: null,
  reason: '',
  range: { from: '2026-07-18', to: '2026-08-17' },
  throughDay: '2026-08-17',
  currency: 'USD',
  billingLagDays: 0,
  // The API can still return Vector Search while frontend removal rolls out.
  // Headline values include it here so the PDF must remove more than its row.
  total: spend(1100),
  spendBreakdown: { attributed: spend(650), standing: spend(450) },
  resources: [
    {
      id: 'app-compute',
      label: 'App compute',
      population: 'This deployment',
      amount: 500,
      standingAmount: 200,
      quality: 'estimate',
    },
    {
      id: 'foundation-model',
      label: 'Foundation model tokens',
      population: 'This deployment',
      amount: 500,
      standingAmount: null,
      quality: 'estimate',
    },
    {
      id: 'vector-search',
      label: 'Vector Search',
      population: 'This deployment',
      amount: 100,
      standingAmount: 50,
      quality: 'estimate',
    },
  ],
  generatedAt: '2026-08-18T12:00:00.000Z',
};

describe('styled cost brief PDF', () => {
  it('renders the supplied reference hierarchy with vector cards, spend split, and resource table', async () => {
    const text = await pdfText(costBriefPdf(costBrief), 'windows-1252');
    expect(text).toContain('(COST BREAKDOWN)');
    expect(text).toContain('(Trailing 31 days)');
    expect(text).toContain('(Window 18 Jul 2026 to 17 Aug 2026 · 31 complete days)');
    expect(text).toContain('(SPEND)');
    expect(text).toContain('(ATTRIBUTED TO QUESTIONS)');
    expect(text).toContain('(STANDING INFRASTRUCTURE)');
    expect(text).toContain('(BY RESOURCE)');
    expect(text).toContain('(Foundation model tokens)');
    expect(text).toContain('(1,000.00)');
    expect(text).toContain('(USD)');
    expect(text).not.toContain('Vector Search');
    // Filled/stroked rectangles and the full-page dark fill prove the output is
    // the supplied dark vector layout, not the generic text or light report.
    expect(text).toMatch(/ re [fB]/);
    expect(text).toContain('0.07 0.09 0.11 rg');
    expect(text).toContain('0.08 0.62 0.48 rg');
    expect(text).toContain('52 705 9 9 re');
    expect(text).toContain('61 714 9 9 re');
  });

  it('gives Dev and Prod separate pages and prints the Prod projection inputs', async () => {
    const text = await pdfText(costBriefPdf(costBrief, 'dev-prod-projection'), 'windows-1252');
    expect(text).toContain('(DEV + PROD PROJECTION · PAGE 1 OF 2)');
    expect(text).toContain('(DEV + PROD PROJECTION · PAGE 2 OF 2)');
    expect(text).toContain('(Development observed)');
    expect(text).toContain('(Production projection)');
    expect(text).toContain('(DEVELOPMENT · OBSERVED)');
    expect(text).toContain('(PRODUCTION · PROJECTED)');
    expect(text).toContain('(PROJECTED PROD)');
    expect(text).toContain('(FIXED HOSTING INPUT)');
    expect(text).toContain('(USAGE INPUT)');
    expect(text).toContain('(PROD INPUTS BY RESOURCE)');
    expect(text).toContain('(PROJECTION ASSUMPTIONS · NOT ACTUAL SPEND)');
    expect(text).toContain('(Fixed hosting input: 100% of reconciled Dev standing spend.)');
    expect(text).toContain('(Usage input: 15% of reconciled Dev question-driven spend.)');
    expect(text).toContain('(Projected figures are displayed to the nearest currency unit.)');
    expect(text).toContain('(490)');
    expect(text).toContain('(USD)');
    expect(text).not.toContain('Vector Search');
    expect(text).toContain('0.07 0.09 0.11 rg');
    expect(text).toContain('0.08 0.62 0.48 rg');
    expect(text.match(/52 705 9 9 re/g)).toHaveLength(2);
  });
});
