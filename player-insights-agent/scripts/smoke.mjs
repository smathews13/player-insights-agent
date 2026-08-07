#!/usr/bin/env node
// Runs the Playwright smoke suite, fetching a browser first only if one is needed.
//
// So: fetch only when nothing launchable is present, and treat an unobtainable
// browser as a skip with a loud notice rather than as a failure. Set
// PLAYER_INSIGHTS_REQUIRE_SMOKE=1 where the suite must genuinely run and a skip
// should be an error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const required = process.env.PLAYER_INSIGHTS_REQUIRE_SMOKE === '1';
const channel = process.env.PLAYWRIGHT_CHANNEL;

// Resolved, not looked up on PATH. node_modules/.bin is only on PATH under `npm
// run`, and a bare `playwright` that fails to spawn exits non-zero with no output
// at all, which is the same silent-looking failure this script exists to remove.
// cli.js sits beside the package entrypoint but is not itself an export, so it
// has to be reached through the directory rather than by subpath.
const cli = path.join(path.dirname(require.resolve('@playwright/test')), 'cli.js');
if (!existsSync(cli)) {
  console.error(`Playwright's CLI is not where this script expects it: ${cli}`);
  process.exit(1);
}

// Launch rather than look for a file on disk. Headless Chromium is a different
// download from the headed one: `chromium.executablePath()` can name a binary
// that exists while the suite still dies on a missing chrome-headless-shell,
// which is the same unhelpful failure wearing a different message. Launching is
// the only check that answers the question the suite actually asks.
async function browserLaunches() {
  try {
    const browser = await chromium.launch(channel ? { channel } : {});
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function playwright(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', ...options });
  if (result.signal === 'SIGTERM' && options.timeout) {
    console.warn(`\n  Gave up on 'playwright ${args.join(' ')}' after ${options.timeout / 1000}s.`);
    return 1;
  }
  if (result.error) {
    console.error(`\n  Could not run ${cli}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (!(await browserLaunches())) {
  console.log('No launchable Chromium, fetching one for the smoke suite.\n');
  // Bounded, because a blocked CDN does not necessarily refuse the connection,
  // it can accept and then never answer, and an unbounded install turns "npm test
  // takes a minute" into "npm test never returns". A timeout here degrades to the
  // skip below, which is the outcome we want on a restricted network anyway.
  playwright(['install', 'chromium'], {
    timeout: Number(process.env.PLAYER_INSIGHTS_BROWSER_FETCH_TIMEOUT_MS ?? 180_000),
  });
}

if (!(await browserLaunches())) {
  const message = [
    '',
    '  SKIPPED: no launchable Chromium, so the smoke suite did not run.',
    '  This is a browser download failing, not a test failing, everything before it passed.',
    '',
    '  Usually a blocked CDN. Two ways to run the suite anyway:',
    '    npx playwright install chromium          # if the download works elsewhere',
    '    PLAYWRIGHT_CHANNEL=chrome npm run test:smoke   # borrow an installed Chrome',
    '',
    '  To make this state an error rather than a skip:',
    '    PLAYER_INSIGHTS_REQUIRE_SMOKE=1 npm run test:smoke',
    '',
  ].join('\n');

  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

process.exit(playwright(['test', 'tests/smoke.spec.ts']));
