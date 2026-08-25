/**
 * The one sky for the whole session: login, Continue, Ask, every other tab.
 *
 * Layout mounts this once, as a sibling of the fading chrome, and never takes
 * it down. `cover` only changes stacking — over the shell while the login card
 * is up, behind the chrome the moment Continue starts — so Continue cannot
 * unmount the SVG, swap a second canvas in, or restart the document seed.
 *
 * It remains mounted in both themes because theme previews update the root
 * attribute without updating React state. base.css and dark-mode.css therefore
 * remain the authority on whether the layer is painted; this component only
 * seats the field.
 */
import { SKY_PAGE_ID, StarField } from './StarField';

export function AppSky({ cover = false }: { cover?: boolean }) {
  return <StarField pageId={SKY_PAGE_ID} surface="ask" className={cover ? 'gate-star-motion' : undefined} />;
}
