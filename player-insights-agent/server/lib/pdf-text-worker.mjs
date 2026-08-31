import { parentPort, workerData } from 'node:worker_threads';

const ABSOLUTE_MAX_TEXT_CHARS = 50_000;

if (!parentPort) throw new Error('PDF extraction worker requires a parent port.');

/**
 * Append one character without ever retaining more than the requested output.
 */
function append(state, value) {
  if (state.text.length >= state.maxChars) return false;
  state.text += value.slice(0, state.maxChars - state.text.length);
  return state.text.length < state.maxChars;
}

/**
 * Normalize PDF.js text items as they arrive.
 *
 * This preserves the old extractor's line/page behavior, but never first builds
 * an unbounded page array. Item strings are consumed character by character and
 * the retained result stops at the prompt's absolute 50k character ceiling.
 */
function appendPage(state, items) {
  let pageStarted = false;
  let lineStarted = false;
  let pendingSpace = false;
  let pendingLineBreaks = 0;
  let previousWasCarriageReturn = false;

  const consume = (character) => {
    if (character === '\n' || character === '\r') {
      if (character === '\n' && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
        return true;
      }
      previousWasCarriageReturn = character === '\r';
      pendingLineBreaks += 1;
      lineStarted = false;
      pendingSpace = false;
      return true;
    }
    previousWasCarriageReturn = false;

    if (/\s/u.test(character)) {
      if (lineStarted) pendingSpace = true;
      return true;
    }

    if (!pageStarted) {
      if (state.text.length > 0 && !append(state, '\n\n')) return false;
      pageStarted = true;
    } else if (!lineStarted && pendingLineBreaks > 0) {
      if (!append(state, pendingLineBreaks >= 2 ? '\n\n' : '\n')) return false;
    } else if (pendingSpace && lineStarted) {
      if (!append(state, ' ')) return false;
    }

    lineStarted = true;
    pendingSpace = false;
    pendingLineBreaks = 0;
    return append(state, character);
  };

  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    for (const character of item.str) {
      if (!consume(character)) return false;
    }
    if (item.hasEOL && !consume('\n')) return false;
  }
  return state.text.length < state.maxChars;
}

async function extract() {
  const bytes = workerData?.bytes;
  const requestedMax = Number(workerData?.maxChars);
  if (!(bytes instanceof ArrayBuffer)) throw new Error('PDF worker received invalid bytes.');
  const maxChars = Math.max(
    1,
    Math.min(
      ABSOLUTE_MAX_TEXT_CHARS,
      Number.isFinite(requestedMax) ? Math.floor(requestedMax) : ABSOLUTE_MAX_TEXT_CHARS
    )
  );

  // Intentionally deferred until a PDF task has its own worker. Ordinary server
  // startup never initializes unpdf or its PDF.js payload.
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
  });
  try {
    const state = { text: '', maxChars };
    for (let pageNumber = 1; pageNumber <= pdf.numPages && state.text.length < maxChars; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        if (!appendPage(state, content.items)) break;
      } finally {
        page.cleanup();
      }
    }
    return state.text;
  } finally {
    await pdf.loadingTask?.destroy();
  }
}

try {
  const text = await extract();
  parentPort.postMessage({ ok: true, text });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    },
  });
}
