import { createApp, lakebase, server } from '@databricks/appkit';
import { lakebasePoolSettings } from './lib/lakebase-pool';
import { preserveOwnedAppSchema } from './lib/app-schema-bootstrap';

// The serving() plugin is deliberately NOT registered. Its invoke path runs the
// request body through two allowlists that drop unknown keys (the plugin's own
// schema filter, then the SDK's servingEndpoints.query() field list), and
// custom_inputs survives neither. The insights route talks to the endpoint
// through apiClient.request() instead, which sends the body verbatim. Adding
// serving() back would republish POST /api/serving/invoke and
// /api/serving/:alias/invoke as lossy entry points; server.test.ts fails if it
// reappears.
// The pool numbers are stated rather than inherited, so a connection-starvation
// problem is answerable with an environment variable. Only the fields AppKit
// actually forwards are passed: it rebuilds the pg config from a fixed field
// list, so `statement_timeout` given here would type-check and be discarded.
// That timeout is applied per session by the read funnel instead — see
// lib/lakebase-pool.ts.
createApp({
  plugins: [lakebase({ pool: lakebasePoolSettings() }), server()],
  async onPluginsReady(appkit) {
    // Git replaces app.yaml, including a bundle release's private schema value,
    // but keeps the App identity and its Postgres ownership. Resolve that owned
    // store before importing modules whose SQL constants capture APP_SCHEMA.
    await preserveOwnedAppSchema(appkit.lakebase);
    const [
      { setupInsightsRoutes },
      { setupSettingsRoutes },
      { setupBrowseRoutes },
      { setupArchitectureRoutes },
      { setupAdminRoutes },
      { setupUserRoutes },
      { setupMonitoringRoutes },
      { setupOpsRoutes },
      { setupEgressRoutes },
      { setupRuntimeSettingsRoutes },
      { bootstrapSeedRoles, isAdminRoute },
      { respondToHandlerFailures },
    ] = await Promise.all([
      import('./routes/insights-routes'),
      import('./routes/settings-routes'),
      import('./routes/browse-routes'),
      import('./routes/architecture-routes'),
      import('./routes/admin-routes'),
      import('./routes/user-routes'),
      import('./routes/monitoring-routes'),
      import('./routes/ops-routes'),
      import('./routes/egress-routes'),
      import('./routes/runtime-settings-routes'),
      import('./lib/admin-roles'),
      import('./lib/handler-failures'),
    ]);
    const { storeReady } = await setupInsightsRoutes(appkit);
    // Role bootstrap is the one boot task that must wait for Lakebase migrations.
    // The database is authoritative at runtime; deployment config may insert the
    // first rows only when the migrated roster is genuinely empty. Waiting keeps a
    // greenfield app from accepting requests before that one-time insert finishes.
    await storeReady;
    await bootstrapSeedRoles(appkit.lakebase);
    // After the insights routes, deliberately: they register the identity gate,
    // and Express applies middleware to whatever is added afterwards. Registering
    // the settings routes first would leave the write route unguarded.
    setupSettingsRoutes(appkit);
    setupRuntimeSettingsRoutes(appkit);
    // After the identity gate: browse calls out as the signed-in user and must
    // refuse unidentified traffic rather than listing under nobody.
    setupBrowseRoutes(appkit);
    // After the identity gate as well, for the same reason: the payload names
    // the app's own service principal and the endpoint it invokes.
    setupArchitectureRoutes(appkit);
    // After the insights routes for a second reason on top of the identity gate:
    // they also register the admin guard, and Express applies middleware to what
    // is added afterwards. Registered first, `/api/admins` would serve the admin
    // list to every consumer who asked for it.
    setupAdminRoutes(appkit);
    // After the insights routes for the reason above and for one more: they register
    // the super-admin guard as well, and Express applies middleware to what is added
    // afterwards. Registered first, `/api/users` would let any administrator appoint
    // and remove administrators, which is the one thing the rank exists to reserve.
    setupUserRoutes(appkit);
    // After the insights routes for the same reason as the two above: the admin
    // guard is registered in there, and Express applies middleware to what is
    // added afterwards. Registered first, Monitoring would serve every person's
    // questions and answers to any signed-in reader. `setupMonitoringRoutes`
    // checks that the guard's prefix list covers each of its paths and registers
    // nothing if it does not, but that check cannot see this ordering, so this is
    // the half of the protection that lives here.
    setupMonitoringRoutes(appkit, { isAdminRoute });
    // After the insights routes for the same reason again, and worth stating
    // separately rather than folding into the note above: these report what this
    // deployment costs and how much of it people use. Registered first, the bill
    // and the traffic would be readable by any signed-in consumer.
    // `setupOpsRoutes` makes the same coverage check against the guard's prefix
    // list and registers nothing if a path is not covered.
    setupOpsRoutes(appkit, { isAdminRoute });
    // After the insights routes for the identity gate above all: the recorder
    // takes the acting person from the request rather than from the body, so a
    // request that reached it without an established identity would record an
    // export against nobody. `setupEgressRoutes` also checks that the admin guard
    // covers its `/api/egress/admin` paths AND leaves the two open ones alone,
    // and registers nothing if either is wrong.
    setupEgressRoutes(appkit, { isAdminRoute });
    // The first-run wizard was removed; configuration comes from the asset
    // bundle. A stale client bundle still calls these, and without an answer
    // here they fall through to the SPA catch-all and receive HTML with a 200,
    // which a `fetch().json()` reports as a parse error rather than as a route
    // that is gone. 410 rather than 404 so a rolling deploy, where a route
    // genuinely is not up yet, stays distinguishable in the logs.
    appkit.server.extend((app) => {
      app.all(/^\/api\/setup(\/|$)/, (_req, res) => {
        res.status(410).json({
          error: 'setup_removed',
          detail:
            'First-run setup was removed. This deployment is configured by its Databricks asset ' +
            'bundle, and saved overrides live on the Connections page.',
        });
      });
    });
    // Last, because Express only reaches an error handler that sits after the
    // route that failed. Handlers that throw are caught by
    // `answerRatherThanExit` and arrive here to be answered as JSON.
    appkit.server.extend(respondToHandlerFailures);
  },
}).catch(console.error);
