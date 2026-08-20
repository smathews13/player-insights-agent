/**
 * App settings: the page the gear in the header opens.
 *
 * Split out of App.tsx when the pages became modules. The flags it edits reach
 * it through the router outlet, which is why it is a page rather than something
 * the header renders itself: the header and this page are then looking at one
 * object and a toggle moves both in the same render.
 */
import { useOutletContext } from 'react-router';
import { AdminListEditor } from './AdminListEditor';
import { UserRoleEditor } from './UserRoleEditor';
import { showsBenchmarkLab, showsEgressControls } from './experimental-features';
import { EgressPanel } from './EgressPanel';
import { showsAdminSurfaces, showsUserRoster, useRole } from './role';
import { Card, CardDescription, CardContent, CardHeader, CardTitle, Switch } from './ui';
import { PageHeading } from './page-chrome';
import type { ExperimentalFeaturesHandle } from './app-types';
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel';

/**
 * What the gear opens: preferences that belong to the reader and to this browser.
 *
 * The split from Connections is the whole design of this page, so it is worth
 * saying where the line is. Here: choices one person makes about what the app
 * shows THEM, held in their own browser, costing nobody else anything.
 * Connections: what this deployment IS -- its catalogs, warehouses, serving and
 * judge endpoints, the preflight report and the identity record -- which is
 * server-side, shared by everybody using the app, and where a wrong value is a
 * broken deployment rather than a hidden tab.
 *
 * Those are different kinds of change, and the editor for the second is entangled
 * with the reporting beside it: it reads and writes `/api/settings` and
 * `/api/settings/values/:id` and shows the preflight those values produced. It
 * has not been moved here, and should not be moved here just to make the gear
 * feel complete. The link below is the join, and it is a link rather than an
 * embed for the same reason the pages are separate.
 *
 * That reasoning stays in this comment and does not appear on the page. A
 * paragraph arguing why deployment configuration is somewhere else was on screen
 * and was cut: it explained a design decision to a reader who had come to flip a
 * switch. Each card says what its controls do and where the other ones are, and
 * nothing here argues for how the app was built.
 *
 * THE ADMINISTRATORS CARD IS THE ONE EXCEPTION to the line above, and it is worth
 * being explicit about why it is not in Connections. It is not a per-browser
 * preference: it changes who can open Monitoring and Ops for everybody. But it is
 * also not a deployment resource. It appoints a PERSON, and it belongs beside the
 * gear that only administrators can see, rather than in a page about catalogs and
 * endpoints. It is first because it is the most consequential control here, and
 * the page's own description is written so that it does not claim otherwise.
 */
export function SettingsPage() {
  const { features, setFeature } = useOutletContext<ExperimentalFeaturesHandle>();
  const role = useRole();

  return (
    <div className="page-shell settings-page">
      <PageHeading title="Settings" />

      {/* The one fact a reader needs before they touch this page: nothing here is
          a lock. The controls decide who administers the deployment and how the
          agent answers, and the server enforces those whether or not this page is
          reachable. Hiding the gear is not a security boundary and the subhead
          says so, per the #24a handoff. */}
      <p className="settings-subhead">Admin only. Enforced on the server, not by hiding this page.</p>

      {/* One Roles card, never the old roster card followed by a second
          Administrators card. A super admin gets the full roster editor; a plain
          administrator gets the server-authorized administrator view. The routes,
          not this branch, remain the permission boundary. */}
      {showsUserRoster(role.state) ? <UserRoleEditor /> : <AdminListEditor />}

      <RuntimeSettingsPanel />

      <Card>
        <CardHeader>
          <CardTitle>Experimental features</CardTitle>
          <CardDescription>Unfinished or internal surfaces, off by default.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="settings-row">
            <div>
              <p className="settings-row-label">
                Benchmarking · {showsBenchmarkLab(features) ? 'Shown' : 'Hidden'}
              </p>
              <p className="settings-row-note">
                Shows the Benchmarking tab, scorers and judge details.
              </p>
            </div>
            <Switch
              checked={showsBenchmarkLab(features)}
              onCheckedChange={(enabled) => setFeature('benchmarkLab', enabled)}
              aria-label="Show Benchmarking, scorers and judge details"
            />
          </div>

          <div className="settings-row">
            <div>
              <p className="settings-row-label">Egress controls</p>
              <p className="settings-row-note">
                Shows which egress paths can be turned off on this deployment. Hiding it does not change what is
                permitted.
              </p>
            </div>
            <Switch
              checked={showsEgressControls(features)}
              onCheckedChange={(enabled) => setFeature('egressControls', enabled)}
              aria-label="Show the egress controls on this page"
            />
          </div>
        </CardContent>
      </Card>

      {/* Below the toggle that reveals it, so turning it on does not move the
          switch the reader just used. Administrators only: the admin routes it
          uses are refused for anybody else on the server whatever is drawn
          here, so this is about not offering dead cards. */}
      {showsEgressControls(features) && showsAdminSurfaces(role.state) ? <EgressPanel /> : null}
    </div>
  );
}
