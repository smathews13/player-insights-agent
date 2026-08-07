import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Server-side PDF text extraction for chat attachments.
 *
 * Backed by `unpdf`, a pre-bundled serverless build of PDF.js. It was chosen over
 * `pdfjs-dist`, `pdf-parse`, and `pdf2json` because it is the only candidate with zero
 * runtime dependencies and no native binary: `pdfjs-dist` and `pdf-parse` both pull in
 * `@napi-rs/canvas` (a platform-specific prebuilt Skia binary), which is what made
 * `databricks apps deploy` hang at "Installing packages...". `unpdf` declares
 * `@napi-rs/canvas` only as an *optional* peer dependency, and needs it solely for
 * rasterisation, never for text extraction.
 */

/**
 * Mirrors `MAX_ATTACHMENT_TEXT` in `server/routes/insights-routes.ts` so a PDF costs the
 * same prompt budget as the plain-text attachment types.
 */
export const MAX_PDF_TEXT_CHARS = 50_000;

/** Upper bound on a single extraction, so a pathological PDF can never hang a request. */
export const PDF_EXTRACTION_TIMEOUT_MS = 15_000;

/** MIME types a browser may report for a PDF upload. */
export const PDF_MIME_TYPES = ['application/pdf', 'application/x-pdf'] as const;

/** Lower-case file extensions that should be routed to {@link extractPdfText}. */
export const PDF_EXTENSIONS = ['pdf'] as const;

export type PdfTextErrorCode =
  /** Nothing to read: zero-length input. */
  | 'empty'
  /** Not a PDF, or a damaged/truncated one. */
  | 'corrupt'
  /** Password protected, so the content cannot be decoded. */
  | 'encrypted'
  /** Structurally valid, but carries no text layer (e.g. a scan). */
  | 'no-text'
  /** Parsing exceeded the time budget. */
  | 'timeout';

/** Extraction failure carrying a stable {@link PdfTextErrorCode} plus a user-facing message. */
export class PdfTextError extends Error {
  readonly code: PdfTextErrorCode;

  /**
   * The underlying PDF.js failure, when there was one. Declared explicitly because the
   * server compiles against the ES2020 lib, which predates `Error.cause`.
   */
  readonly cause?: unknown;

  constructor(code: PdfTextErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PdfTextError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export interface ExtractPdfTextOptions {
  /** Truncate the result to this many characters. Defaults to {@link MAX_PDF_TEXT_CHARS}. */
  maxChars?: number;
  /** Reject after this long. Defaults to {@link PDF_EXTRACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** True when `filename` has a PDF extension. */
export function isPdfFilename(filename: string): boolean {
  // A leading dot means a hidden file with no extension (`.pdf`), not a PDF.
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = filename.slice(dot + 1).toLowerCase();
  return (PDF_EXTENSIONS as readonly string[]).includes(extension);
}

/** True when `mimeType` (with or without parameters) denotes a PDF. */
export function isPdfMimeType(mimeType: string): boolean {
  const essence = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (PDF_MIME_TYPES as readonly string[]).includes(essence);
}

/**
 * PDF.js *transfers* the buffer it is handed, which detaches the caller's `ArrayBuffer`.
 * For a Node `Buffer` that memory belongs to a shared pool, so handing `req.body` straight
 * through corrupts unrelated buffers. This parses a private copy for that reason.
 */
function toOwnedCopy(input: Buffer | Uint8Array): Uint8Array {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy;
}

/** PDF.js reports failures via `error.name`; it does not use error codes. */
function toPdfTextError(error: unknown): PdfTextError {
  if (error instanceof PdfTextError) return error;

  if (error instanceof Error && error.name === 'PasswordException') {
    return new PdfTextError('encrypted', 'This PDF is password protected. Remove the password and upload it again.', {
      cause: error,
    });
  }

  // `InvalidPDFException` plus anything unrecognised: the file is unusable either way.
  return new PdfTextError('corrupt', 'This PDF could not be read. It may be corrupt or incomplete.', {
    cause: error,
  });
}

/**
 * Collapse the ragged whitespace PDF.js emits: trim each line, drop runs of blank lines,
 * and normalise line endings. Keeps the text compact so the prompt budget buys more content.
 */
function normalizeText(pages: string[]): string {
  return pages
    .map((page) =>
      page
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
    .filter((page) => page.length > 0)
    .join('\n\n');
}

/**
 * Extract the text layer from a PDF.
 *
 * @param input Raw PDF bytes. Not mutated. An internal copy is parsed.
 * @returns Extracted text, whitespace-normalised and truncated to `maxChars`.
 * @throws {PdfTextError} for empty, corrupt, encrypted, text-free, or slow PDFs.
 */
export async function extractPdfText(input: Buffer | Uint8Array, options: ExtractPdfTextOptions = {}): Promise<string> {
  const maxChars = options.maxChars ?? MAX_PDF_TEXT_CHARS;
  const timeoutMs = options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS;

  if (input.byteLength === 0) {
    throw new PdfTextError('empty', 'This PDF is empty.');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  // `extractText` is incrementally async, so the timer gets a chance to fire between
  // pages. It is a backstop against a slow document, not a hard interrupt.
  const work = (async () => {
    // Keep PDF.js strictly on the text path: with image decoding off it never reaches for
    // a canvas, and XFA form scripting stays disabled.
    const pdf = await getDocumentProxy(toOwnedCopy(input), {
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
    });
    try {
      const { text } = await extractText(pdf, { mergePages: false });
      return text;
    } finally {
      // This PDF.js build exposes teardown on the loading task, not the document proxy.
      await pdf.loadingTask?.destroy();
    }
  })();

  // Mark `work` as handled so losing the race never surfaces as an unhandled rejection.
  work.catch(() => {});

  let pages: string[];
  try {
    pages = await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PdfTextError('timeout', 'This PDF took too long to process. Try a smaller file.')),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    throw toPdfTextError(error);
  } finally {
    clearTimeout(timer);
  }

  const text = normalizeText(pages);
  if (!text) {
    throw new PdfTextError('no-text',
      'No readable text was found in this report. Scanned or image-only PDFs are not supported.'
    );
  }

  return text.slice(0, maxChars);
}
