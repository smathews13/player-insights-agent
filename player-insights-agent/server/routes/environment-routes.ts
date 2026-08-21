import type { InsightsAppKit } from './insights-routes';
import { readEnvironmentInfo } from '../lib/environment-info';

export function setupEnvironmentRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    app.get('/api/environment', async (_req, res) => {
      try {
        res.json(await readEnvironmentInfo());
      } catch (error) {
        console.error('[environment] Runtime details could not be read:', (error as Error).message);
        res.status(503).json({
          error: 'environment_unavailable',
          detail: 'Runtime details are not available just now.',
        });
      }
    });
  });
}
