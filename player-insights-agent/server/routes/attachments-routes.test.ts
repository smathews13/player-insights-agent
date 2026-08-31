import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';

// The PDF fixtures belong to server/lib/pdf-text.ts. They are read, never modified, so the
// route tests exercise the same real documents the extractor is verified against.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', '__fixtures__');
const loadFixture = (name: string) => readFile(path.join(fixtureDir, name));

interface StoredAttachment {
  filename: string;
  extracted_text: string;
}

/**
 * A Lakebase stand-in that is just real enough for the attachment lifecycle: it remembers
 * what the upload route inserted so the ask route can read it back.
 */
function createLakebase() {
  const attachments: StoredAttachment[] = [];
  return {
    attachments,
    query(text: string, params: unknown[] = []) {
      if (text.includes('INSERT INTO player_insights.attachments')) {
        attachments.push({ filename: String(params[3]), extracted_text: String(params[6]) });
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM player_insights.attachments') && text.includes('extracted_text')) {
        return Promise.resolve({ rows: attachments as unknown as Record<string, unknown>[] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

let server: Server;
let baseUrl: string;
let lakebase: ReturnType<typeof createLakebase>;
let servingPayloads: Record<string, unknown>[];

let simpleText: Buffer;
let encrypted: Buffer;
let imageOnly: Buffer;

beforeAll(async () => {
  [simpleText, encrypted, imageOnly] = await Promise.all([
    loadFixture('simple-text.pdf'),
    loadFixture('encrypted.pdf'),
    loadFixture('image-only.pdf'),
  ]);

  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'player-insights-agent';
  lakebase = createLakebase();
  servingPayloads = [];

  const app = express();
  app.use(express.json());
  const appkit: InsightsAppKit = {
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: ({ payload }) => {
      servingPayloads.push(payload);
      return Promise.resolve({});
    },
  };
  await setupInsightsRoutes(appkit);

  // Loopback rather than the wildcard, or this binds a port another process holds
  // on 127.0.0.1 and the fetches below reach that process. See shared-rail.test.ts.
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

function upload(filename: string, body: Buffer, conversationId = 'conv-pdf') {
  return fetch(`${baseUrl}/api/conversations/${conversationId}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(filename),
      'X-File-Type': 'application/pdf',
    },
    body: new Uint8Array(body),
  });
}

describe('PDF upload route', () => {
  it('accepts a text-bearing PDF and stores the extracted text', async () => {
    const response = await upload('quarterly-report.pdf', simpleText);

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.filename).toBe('quarterly-report.pdf');
    expect(body.status).toBe('ready');

    const stored = lakebase.attachments.find((a) => a.filename === 'quarterly-report.pdf');
    expect(stored).toBeDefined();
    expect(stored?.extracted_text.length).toBeGreaterThan(0);
    // Text, not raw PDF bytes.
    expect(stored?.extracted_text).not.toContain('%PDF');
  });

  it('bypasses the NUL-byte binary guard that plain-text uploads use', () => {
    // The guard inspects the first 8 KB, and a real PDF has NUL bytes there. The upload above
    // returning 201 is only possible because PDFs are routed before that check.
    expect(simpleText.subarray(0, 8000).includes(0)).toBe(true);
  });

  it('still rejects a renamed binary that is not a PDF', async () => {
    const response = await upload('renamed.csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'This file looks binary. Use a plain-text TXT, Markdown, CSV, or JSON file.',
    });
  });

  it('names PDF in the unsupported-format message', async () => {
    const response = await upload('deck.pptx', Buffer.from('not a deck', 'utf8'));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Use a PDF, TXT, Markdown, CSV, or JSON file.',
    });
  });

  it('refuses more than 8 MB in the body parser before PDF worker transfer', async () => {
    const response = await upload('oversized.pdf', Buffer.alloc(8 * 1024 * 1024 + 1));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Choose a non-empty report no larger than 8 MB.',
    });
  });
});

describe('PdfTextError messages reach the client verbatim', () => {
  it('encrypted: surfaces the password-protected message', async () => {
    const response = await upload('protected.pdf', encrypted);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'This PDF is password protected. Remove the password and upload it again.',
    });
  });

  it('no-text: surfaces the scanned/image-only message, not the generic one', async () => {
    const response = await upload('scan.pdf', imageOnly);

    expect(response.status).toBe(422);
    // The route has its own generic "No readable text was found in this report." fallback for
    // whitespace-only text files. The extractor throws first, so the specific message wins.
    expect(await response.json()).toEqual({
      error: 'No readable text was found in this report. Scanned or image-only PDFs are not supported.',
    });
  });

  it('corrupt: surfaces the unreadable-file message', async () => {
    const response = await upload('broken.pdf', Buffer.from('%PDF-1.7 truncated', 'utf8'));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'This PDF could not be read. It may be corrupt or incomplete.',
    });
  });

  it('empty: a zero-byte upload is caught by the route size guard before the extractor', async () => {
    const response = await upload('empty.pdf', Buffer.alloc(0));

    // Documents that PdfTextError('empty') is unreachable through this route: the shared
    // non-empty guard answers first, with an equivalent message, for every format.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Choose a non-empty report no larger than 8 MB.',
    });
  });
});

describe('PDF text reaches the agent', () => {
  it('flows into custom_inputs.attachment_text on the next question', async () => {
    const uploaded = await upload('board-notes.pdf', simpleText, 'conv-flow');
    expect(uploaded.status).toBe(201);
    const stored = lakebase.attachments.find((a) => a.filename === 'board-notes.pdf');
    expect(stored).toBeDefined();

    servingPayloads.length = 0;
    const asked = await fetch(`${baseUrl}/api/insights/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-flow', prompt: 'Summarise the attached report.' }),
    });
    // Not `asked.ok`. The transport above answers `{}`, which matches none of
    // the four shapes the app reads, and that is now reported as unavailable
    // rather than answered with the stored demo response. What this test is
    // about is what went OUT, and the request reaching the transport at all is
    // what proves the attachment text was carried.
    expect(asked.status).toBe(502);

    expect(servingPayloads).toHaveLength(1);
    const customInputs = servingPayloads[0]?.custom_inputs as Record<string, unknown>;
    const attachmentText = String(customInputs.attachment_text);
    expect(attachmentText).toContain('board-notes.pdf');
    // The PDF's own words, not a placeholder or the raw bytes.
    expect(attachmentText).toContain(stored?.extracted_text.slice(0, 60) ?? '__missing__');
  });
});
