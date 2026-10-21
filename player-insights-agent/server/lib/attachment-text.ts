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
}

const SEPARATOR = '\n\n';

export function fitAttachmentText(rows: readonly AttachmentRow[], limit: number): { text: string; cut: string[] } {
  const parts: string[] = [];
  const cut: string[] = [];
  let room = limit;
  const newestFirst = [...rows].reverse();
  for (let index = 0; index < newestFirst.length; index += 1) {
    const row = newestFirst[index];
    const part = `## ${String(row.filename)}\n${String(row.extracted_text)}`;
    const cost = part.length + (parts.length ? SEPARATOR.length : 0);
    if (cost <= room) {
      parts.unshift(part);
      room -= cost;
      continue;
    }
    // The file that straddles the limit is shortened; everything older is lost whole.
    const keep = room - (parts.length ? SEPARATOR.length : 0);
    if (keep > 0) parts.unshift(part.slice(0, keep));
    cut.unshift(String(row.filename));
    for (const older of newestFirst.slice(index + 1)) cut.unshift(String(older.filename));
    break;
  }
  return { text: parts.join(SEPARATOR), cut };
}
