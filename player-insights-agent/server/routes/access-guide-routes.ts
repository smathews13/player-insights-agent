import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import type { InsightsAppKit } from './insights-routes';

export const ACCESS_GUIDE_FILENAME = 'Player_Insights_Agent_Access_Patterns_v2.pdf';
export const ACCESS_GUIDE_DOWNLOAD_PATH = '/api/admin/access-guide';
export const ACCESS_GUIDE_META_PATH = '/api/admin/access-guide/meta';

/**
 * Development reads the tracked internal source. Production reads only the
 * bundled asset beside server.mjs, so moving a public artifact cannot make the
 * handler reach back into an unrelated source checkout.
 */
export function accessGuideAssetPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const directory = env.NODE_ENV?.trim().toLowerCase() === 'production' ? 'assets' : 'docs';
  return path.join(cwd, directory, ACCESS_GUIDE_FILENAME);
}

async function accessGuideAvailable(assetPath: string): Promise<boolean> {
  try {
    return (await stat(assetPath)).isFile();
  } catch {
    return false;
  }
}

function unavailable(res: Response): void {
  res.status(404).json({
    error: 'access_guide_unavailable',
    detail: 'The access guide is not available in this build.',
  });
}

export function setupAccessGuideRoutes(appkit: InsightsAppKit, options: { assetPath?: string } = {}): void {
  const assetPath = options.assetPath ?? accessGuideAssetPath();

  appkit.server.extend((app) => {
    app.get(ACCESS_GUIDE_META_PATH, async (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ available: await accessGuideAvailable(assetPath) });
    });

    app.get(ACCESS_GUIDE_DOWNLOAD_PATH, async (_req, res) => {
      let file: FileHandle | undefined;
      try {
        file = await open(assetPath, 'r');
        const info = await file.stat();
        if (!info.isFile()) {
          await file.close();
          unavailable(res);
          return;
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${ACCESS_GUIDE_FILENAME}"`);
        res.setHeader('Content-Length', String(info.size));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

        const stream = file.createReadStream();
        stream.on('error', (error) => {
          if (!res.headersSent) unavailable(res);
          else res.destroy(error);
        });
        stream.pipe(res);
      } catch {
        if (file) await file.close().catch(() => undefined);
        unavailable(res);
      }
    });
  });
}
