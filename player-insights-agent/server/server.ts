import { createApp, lakebase, server } from '@databricks/appkit';
import { setupInsightsRoutes } from './routes/insights-routes';
import { setupSettingsRoutes } from './routes/settings-routes';
import { respondToHandlerFailures } from './lib/handler-failures';

// The serving() plugin is deliberately NOT registered. Its invoke path runs the
// request body through two allowlists that drop unknown keys (the plugin's own
// schema filter, then the SDK's servingEndpoints.query() field list), and
// custom_inputs survives neither. The insights route talks to the endpoint
// through apiClient.request() instead, which sends the body verbatim. Adding
// serving() back would republish POST /api/serving/invoke and
// /api/serving/:alias/invoke as lossy entry points; server.test.ts fails if it
// reappears.
createApp({
  plugins: [lakebase(), server()],
  async onPluginsReady(appkit) {
    await setupInsightsRoutes(appkit);
    // After the insights routes, deliberately: they register the identity gate,
    // and Express applies middleware to whatever is added afterwards. Registering
    // the settings routes first would leave the write route unguarded.
    setupSettingsRoutes(appkit);
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
