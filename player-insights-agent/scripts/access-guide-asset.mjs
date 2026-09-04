import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const ACCESS_GUIDE_FILENAME = 'Player_Insights_Agent_Access_Patterns_v2.pdf';

async function sourceFile(pathname) {
  try {
    const info = await stat(pathname);
    if (!info.isFile()) throw new Error(`Access guide source is not a file: ${pathname}`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Copy the confidential guide only when this internal source checkout carries
 * it. Public mirrors deliberately omit the source and therefore produce no
 * deploy asset, while stale output is removed if this helper is called alone.
 */
export async function copyAccessGuideAsset({ root, outDir, log = console.log }) {
  const source = path.join(root, 'docs', ACCESS_GUIDE_FILENAME);
  const destination = path.join(outDir, 'assets', ACCESS_GUIDE_FILENAME);
  if (!(await sourceFile(source))) {
    await rm(destination, { force: true });
    log('  note  internal access guide absent; no confidential PDF was bundled.');
    return { copied: false, source, destination };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const [sourceBytes, destinationBytes] = await Promise.all([readFile(source), readFile(destination)]);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Bundled access guide differs from its tracked source: ${destination}`);
  }
  return { copied: true, source, destination, bytes: sourceBytes.length };
}
