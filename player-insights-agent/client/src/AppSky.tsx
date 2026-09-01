/**
 * The one sky for the whole session: login, Continue, Ask, every other tab.
 *
 * Layout mounts this only after startup gates are complete. Login and access
 * surfaces do not mount a second sky or hide one behind their cards.
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
