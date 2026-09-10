export async function copyExportText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
  await navigator.clipboard.writeText(text);
}

/** Starts a browser download and always releases its temporary object URL. */
export function downloadExportBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Keep the URL alive through the click task, then release it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadExportText(text: string, filename: string, type = 'text/markdown;charset=utf-8'): void {
  downloadExportBlob(new Blob([text], { type }), filename);
}
