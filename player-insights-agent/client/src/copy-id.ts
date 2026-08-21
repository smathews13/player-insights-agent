/**
 * Putting a value on the clipboard from a page that is not always allowed to.
 *
 * `navigator.clipboard.writeText` is a promise, and every copy affordance in
 * this app fired it with `void` -- so when the browser refused, the rejection
 * went nowhere and the button looked inert. It refuses more often than the code
 * assumed: the async clipboard is gated on a secure context AND on the frame
 * holding `clipboard-write`, and an app served inside an embedding frame has
 * neither guaranteed. The object exists, the call resolves to nothing, and the
 * reader clicks again.
 *
 * So the write is awaited, its failure is caught, and the old selection-based
 * copy runs as the fallback -- that one is synchronous, needs no permission,
 * and works in the frames the async API will not. The boolean is what the
 * caller confirms on: a chip must not flash "Copied" over a copy that failed.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Refused by permission or by context. The selection path below is the
    // whole reason this helper exists, so this is a fall-through, not an error.
  }
  return selectionCopy(value);
}

/**
 * The pre-permission copy: a textarea off-screen, selected, and `execCommand`.
 *
 * Deprecated and still the only thing that works in a frame without
 * `clipboard-write`. Off-screen rather than `display: none`, because a hidden
 * element cannot hold a selection, and `readOnly` so no keyboard opens on a
 * touch device for the instant it is in the document.
 */
function selectionCopy(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '-1000px';
  field.style.opacity = '0';
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
