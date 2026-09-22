import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dashboardRenderableFrom } from '../../shared/dashboard-contract';
import { DASHBOARD_SANDBOX, dashboardFrameProps, jsonDocumentText } from './dashboard-rendering';

const COMPONENT = readFileSync(new URL('./DashboardHtmlCard.tsx', import.meta.url), 'utf8');
const RENDERING = readFileSync(new URL('./dashboard-rendering.ts', import.meta.url), 'utf8');

describe('backend-selected dashboard renderables', () => {
  const html = ' \n<!doctype html><html><body><script>draw()</script><main>Revenue</main></body></html>\n ';

  it('passes the exact backend string through the contract and iframe props', () => {
    const received = dashboardRenderableFrom({
      type: 'dashboard',
      renderable: { format: 'html', content: html },
    });

    expect(received).toEqual({ format: 'html', content: html });
    expect(dashboardFrameProps(received?.format === 'html' ? received.content : '').srcDoc).toBe(html);
  });

  it('uses browser isolation without parsing or rewriting the document', () => {
    expect(DASHBOARD_SANDBOX).toContain('allow-scripts');
    expect(DASHBOARD_SANDBOX).not.toContain('allow-same-origin');
    expect(RENDERING).toContain('srcDoc: html');
    expect(`${COMPONENT}\n${RENDERING}`).not.toContain('DOMParser');
    expect(`${COMPONENT}\n${RENDERING}`).not.toContain('dangerouslySetInnerHTML');
    expect(`${COMPONENT}\n${RENDERING}`).not.toContain('sanitizeHtml(');
    expect(`${COMPONENT}\n${RENDERING}`).not.toContain('sanitize(');
  });

  it('preserves backend JSON as JSON rather than deriving dashboard components', () => {
    const object = { title: 'Revenue', tiles: [{ value: 42 }] };
    const received = dashboardRenderableFrom({
      type: 'dashboard',
      renderable: { format: 'json', content: object },
    });

    expect(received).toMatchObject({ format: 'json', content: object });
    expect(received?.content).toBe(object);
    expect(jsonDocumentText(object)).toBe('{\n  "title": "Revenue",\n  "tiles": [\n    {\n      "value": 42\n    }\n  ]\n}');
    expect(jsonDocumentText('{\n\t"title": "Revenue"\n}')).toBe('{\n\t"title": "Revenue"\n}');
  });

  it('keeps legacy dashboard_html readable during rolling deploys', () => {
    expect(dashboardRenderableFrom({ type: 'dashboard', dashboard_html: html })).toEqual({
      format: 'html',
      content: html,
    });
  });
});
