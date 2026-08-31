import { Worker, type WorkerOptions } from 'node:worker_threads';

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

/** Matches the attachment route's upload ceiling and is checked before worker transfer. */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** At most two PDF.js heaps may exist in this server process at once. */
export const MAX_CONCURRENT_PDF_EXTRACTIONS = 2;

/** A short bounded wait absorbs a burst without retaining an unlimited number of uploads. */
export const MAX_QUEUED_PDF_EXTRACTIONS = 4;

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
  | 'timeout'
  /** The upload exceeded the route's existing eight-megabyte limit. */
  | 'too-large'
  /** The bounded parser pool and its queue are both occupied. */
  | 'overloaded'
  /** The owning request or session ended before parsing completed. */
  | 'cancelled';

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
  /** Reject after this long, capped at {@link PDF_EXTRACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Stop queued or active work when the request/session that owns it ends. */
  signal?: AbortSignal;
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

interface PdfWorkerSuccess {
  ok: true;
  text: string;
}

interface PdfWorkerFailure {
  ok: false;
  error: {
    name: string;
    message: string;
  };
}

type PdfWorkerResult = PdfWorkerSuccess | PdfWorkerFailure;

interface PdfExtractionTask {
  input: Buffer | Uint8Array;
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (text: string) => void;
  reject: (error: PdfTextError) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  worker?: Worker;
  state: 'queued' | 'active' | 'settling';
  settled: boolean;
}

export interface PdfExtractionPoolOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  workerUrl?: URL;
  workerOptions?: Pick<WorkerOptions, 'resourceLimits'>;
}

/**
 * Bounded owner of PDF worker lifetimes.
 *
 * A fresh worker is used for every document so timeout/cancellation can be a hard
 * termination rather than a Promise race that leaves PDF.js running in the server.
 */
export class PdfExtractionPool {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly workerUrl: URL;
  readonly workerOptions: Pick<WorkerOptions, 'resourceLimits'>;

  private readonly active = new Set<PdfExtractionTask>();
  private readonly queue: PdfExtractionTask[] = [];

  constructor(options: PdfExtractionPoolOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? MAX_CONCURRENT_PDF_EXTRACTIONS));
    this.maxQueued = Math.max(0, Math.floor(options.maxQueued ?? MAX_QUEUED_PDF_EXTRACTIONS));
    this.workerUrl = options.workerUrl ?? new URL('./pdf-text-worker.mjs', import.meta.url);
    this.workerOptions = options.workerOptions ?? { resourceLimits: { maxOldGenerationSizeMb: 128 } };
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active.size, queued: this.queue.length };
  }

  extract(input: Buffer | Uint8Array, options: ExtractPdfTextOptions = {}): Promise<string> {
    if (input.byteLength === 0) {
      return Promise.reject(new PdfTextError('empty', 'This PDF is empty.'));
    }
    if (input.byteLength > MAX_PDF_BYTES) {
      return Promise.reject(new PdfTextError('too-large', 'Choose a non-empty report no larger than 8 MB.'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new PdfTextError('cancelled', 'PDF processing was cancelled.'));
    }
    if (this.active.size >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new PdfTextError('overloaded', 'PDF processing is busy. Wait a moment and try this report again.')
      );
    }

    const requestedMax = Math.floor(options.maxChars ?? MAX_PDF_TEXT_CHARS);
    const maxChars = Number.isFinite(requestedMax)
      ? Math.max(1, Math.min(MAX_PDF_TEXT_CHARS, requestedMax))
      : MAX_PDF_TEXT_CHARS;
    const requestedTimeout = Math.floor(options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(1, Math.min(PDF_EXTRACTION_TIMEOUT_MS, requestedTimeout))
      : PDF_EXTRACTION_TIMEOUT_MS;

    return new Promise<string>((resolve, reject) => {
      const task: PdfExtractionTask = {
        input,
        maxChars,
        timeoutMs,
        signal: options.signal,
        resolve,
        reject,
        state: 'queued',
        settled: false,
      };
      task.timer = setTimeout(() => {
        void this.settle(task, new PdfTextError('timeout', 'This PDF took too long to process. Try a smaller file.'));
      }, timeoutMs);
      task.timer.unref();
      task.abort = () => {
        void this.settle(task, new PdfTextError('cancelled', 'PDF processing was cancelled.'));
      };
      task.signal?.addEventListener('abort', task.abort, { once: true });

      if (this.active.size < this.maxConcurrent) this.start(task);
      else this.queue.push(task);
    });
  }

  /** Terminates every worker and rejects queued work; primarily used by orderly shutdown/tests. */
  async close(): Promise<void> {
    const tasks = [...this.queue, ...this.active];
    await Promise.all(
      tasks.map((task) => this.settle(task, new PdfTextError('cancelled', 'PDF processing was cancelled.')))
    );
  }

  private start(task: PdfExtractionTask): void {
    if (task.settled) return;
    task.state = 'active';
    this.active.add(task);

    // PDF.js transfers its input. Copy only after admission, then transfer the
    // private allocation so neither a pooled request Buffer nor queued bytes detach.
    const owned = new Uint8Array(task.input.byteLength);
    owned.set(task.input);
    try {
      const worker = new Worker(this.workerUrl, {
        ...this.workerOptions,
        workerData: { bytes: owned.buffer, maxChars: task.maxChars },
        transferList: [owned.buffer],
      });
      task.worker = worker;
      worker.once('message', (message: unknown) => {
        const result = message as PdfWorkerResult;
        if (result?.ok === true && typeof result.text === 'string') {
          const text = result.text.slice(0, task.maxChars);
          void this.settle(
            task,
            text.trim()
              ? text
              : new PdfTextError(
                  'no-text',
                  'No readable text was found in this report. Scanned or image-only PDFs are not supported.'
                )
          );
          return;
        }
        if (
          result?.ok === false &&
          typeof result.error?.name === 'string' &&
          typeof result.error.message === 'string'
        ) {
          const cause = new Error(result.error.message);
          cause.name = result.error.name;
          void this.settle(task, toPdfTextError(cause));
          return;
        }
        void this.settle(task, toPdfTextError(new Error('PDF worker returned an invalid result.')));
      });
      worker.once('error', (error) => {
        void this.settle(task, toPdfTextError(error));
      });
      worker.once('exit', (code) => {
        if (!task.settled) {
          void this.settle(task, toPdfTextError(new Error(`PDF worker exited before returning text (${code}).`)));
        }
      });
    } catch (error) {
      void this.settle(task, toPdfTextError(error));
    }
  }

  private async settle(task: PdfExtractionTask, outcome: string | PdfTextError): Promise<void> {
    if (task.settled) return;
    task.settled = true;
    task.state = 'settling';
    clearTimeout(task.timer);
    if (task.abort) task.signal?.removeEventListener('abort', task.abort);

    const queuedIndex = this.queue.indexOf(task);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);

    if (task.worker) {
      try {
        await task.worker.terminate();
      } catch {
        // A worker that already exited is just as terminated as one we stopped.
      }
    }
    this.active.delete(task);

    if (typeof outcome === 'string') task.resolve(outcome);
    else task.reject(outcome);
    this.pump();
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next && !next.settled) this.start(next);
    }
  }
}

const pdfExtractionPool = new PdfExtractionPool();

/**
 * Extract the text layer from a PDF.
 *
 * `unpdf` is not imported by this module. It is dynamically loaded inside a
 * terminable worker only after the task has passed byte, concurrency, and queue
 * admission checks.
 */
export async function extractPdfText(input: Buffer | Uint8Array, options: ExtractPdfTextOptions = {}): Promise<string> {
  return pdfExtractionPool.extract(input, options);
}
