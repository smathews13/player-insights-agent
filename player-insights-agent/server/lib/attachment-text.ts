/**
 * Which attached files fit the conversation's character limit.
 *
 * The newest files win the space. The joined text used to be cut from the end, which
 * is the newest file -- usually the one just uploaded -- and nothing told the reader.
 * The result keeps UPLOAD order and the `## <filename>` header format, because the
 * agent finds file boundaries by that header and releases separately from this app.
 */
export interface AttachmentRow {
  filename: unknown;
  extracted_text: unknown;
  /** Only the start of the file was stored at upload. */
  truncated?: unknown;
}

/**
 * What reached the agent of one file, sent as `custom_inputs.files_sent`.
 * `original_chars` is null when the file was cut at upload: only its stored start
 * is kept, so its full length is not known here.
 */
export interface AttachmentSent {
  filename: string;
  truncated: boolean;
  original_chars: number | null;
  kept_chars: number;
}

const SEPARATOR = '\n\n';

export function fitAttachmentText(
  rows: readonly AttachmentRow[],
  limit: number
): { text: string; cut: string[]; files: AttachmentSent[] } {
  const parts: string[] = [];
  const cut: string[] = [];
  const kept = new Array<number>(rows.length).fill(0);
  let room = limit;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const header = `## ${String(row.filename)}\n`;
    const body = String(row.extracted_text);
    const part = header + body;
    const cost = part.length + (parts.length ? SEPARATOR.length : 0);
    if (cost <= room) {
      parts.unshift(part);
      kept[index] = body.length;
      room -= cost;
      continue;
    }
    // The file that straddles the limit is shortened; everything older is lost whole.
    const keep = room - (parts.length ? SEPARATOR.length : 0);
    if (keep > 0) {
      parts.unshift(part.slice(0, keep));
      kept[index] = Math.max(0, keep - header.length);
    }
    for (let older = 0; older <= index; older += 1) cut.push(String(rows[older].filename));
    break;
  }
  const files = rows.map((row, index) => {
    const truncated = row.truncated === true;
    return {
      filename: String(row.filename),
      truncated,
      original_chars: truncated ? null : String(row.extracted_text).length,
      kept_chars: kept[index],
    };
  });
  return { text: parts.join(SEPARATOR), cut, files };
}
