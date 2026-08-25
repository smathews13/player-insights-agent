/**
 * The fixed sky mounted by the app shell.
 *
 * Same drawing as the login gate: `SKY_PAGE_ID` plus the tab-local document
 * seed. Route changes used to rebuild a different constellation (and drop the
 * connectors on every tab that was not Ask). The sky stays one surface from
 * Continue through Settings.
 *
 * It remains mounted in both themes because theme previews update the root
 * attribute without updating React state. base.css and dark-mode.css therefore
 * remain the authority on whether the layer is painted; this component only
 * seats the field.
 */
import { SKY_PAGE_ID, StarField } from './StarField';

export function AppSky() {
  return <StarField pageId={SKY_PAGE_ID} surface="ask" />;
}
