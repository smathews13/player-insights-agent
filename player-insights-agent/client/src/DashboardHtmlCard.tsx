import type { DashboardRenderable } from '../../shared/dashboard-contract';
import { dashboardFrameProps, jsonDocumentText } from './dashboard-rendering';

/**
 * Generic browser surfaces for backend-authored renderables.
 *
 * Ownership is intentionally one-way: the backend selects the format and owns
 * the payload. The app does not extract a title or rebuild either format as
 * dashboard-specific React components.
 */

export function DashboardRenderableCard({ renderable }: { renderable: DashboardRenderable }) {
  if (renderable.format === 'html') {
    return <iframe className="dashboard-html-frame" {...dashboardFrameProps(renderable.content)} />;
  }
  return (
    <pre className="dashboard-json-document">
      <code>{jsonDocumentText(renderable.content)}</code>
    </pre>
  );
}
