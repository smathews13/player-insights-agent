/**
 * The fixed sky mounted by the app shell.
 *
 * It remains mounted in both themes because theme previews update the root
 * attribute without updating React state. base.css and dark-mode.css therefore
 * remain the authority on whether the layer is painted; this component only
 * chooses whether the current route is the Ask hero or a dense working screen.
 */
import { StarField, type StarSurface } from './StarField';

function currentPage(): string {
  return typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
}

function surfaceFor(pageId: string): StarSurface {
  return pageId === '/' ? 'ask' : 'working';
}

export function AppSky() {
  const pageId = currentPage();
  return <StarField pageId={pageId} surface={surfaceFor(pageId)} />;
}
