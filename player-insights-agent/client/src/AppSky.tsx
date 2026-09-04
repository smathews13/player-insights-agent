/**
 * The one sky for the whole session: login, Continue, Ask, every other tab.
 *
 * Layout mounts this while the startup loader still covers the hidden shell.
 * It is therefore already settled behind login and remains the same element
 * through the handoff to Ask.
 *
 * It remains mounted in both themes because theme previews update the root
 * attribute without updating React state. base.css and dark-mode.css therefore
 * remain the authority on whether the layer is painted; this component only
 * seats the field.
 */
import { AppTopology, SKY_PAGE_ID } from './StarField';

export function AppSky() {
  return <AppTopology pageId={SKY_PAGE_ID} />;
}
