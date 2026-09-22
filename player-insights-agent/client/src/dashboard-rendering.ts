export const DASHBOARD_SANDBOX =
  'allow-downloads allow-forms allow-modals allow-popups allow-scripts' as const;

/** Kept pure so a contract test can prove the HTML string is passed unchanged. */
export function dashboardFrameProps(html: string) {
  return {
    srcDoc: html,
    sandbox: DASHBOARD_SANDBOX,
    title: 'Generated dashboard',
  };
}

/** Preserve a formatted JSON string; serialize a semantic JSON value once. */
export function jsonDocumentText(content: unknown): string {
  return typeof content === 'string' ? content : (JSON.stringify(content, null, 2) ?? '');
}
