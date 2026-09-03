/**
 * That the Ops routes are guarded, and that being guarded does not silently
 * switch them off.
 *
 * TWO FAILURES THAT LOOK NOTHING ALIKE AND ARE ONE MISTAKE. The admin guard is a
 * single `app.use` that decides whether to refuse by testing the request path
 * against a prefix list in another file. If that list stops covering `/api/ops`,
 * two things happen at once: `setupOpsRoutes` refuses to register anything, so
 * the whole tab answers 404 and looks like a deploy that half-landed; and had it
 * registered anyway, this deployment's spend and traffic would be readable by
 * any signed-in consumer.
 *
 * Neither is visible in a diff to `admin-roles.ts`, because the prefix that
 * matters is absent rather than wrong. So the coverage is asserted from the
 * route side, where the paths actually live.
 */
import { describe, expect, it } from 'vitest';

import { isAdminRoute } from '../lib/admin-roles';
import { OPS_ROUTES, setupOpsRoutes } from './ops-routes';

describe('the admin guard and the Ops routes', () => {
  it('covers every path this file serves', () => {
    // The check `setupOpsRoutes` runs at boot, run here so it fails in CI rather
    // than at a reader who finds the tab missing.
    const uncovered = OPS_ROUTES.filter((path) => !isAdminRoute(path));
    expect(uncovered).toEqual([]);
  });

  it('registers nothing at all when the guard does not cover them', () => {
    // Loud and empty rather than quiet and open. A 404 on Ops is reported in a
    // minute; an unguarded Ops is a disclosure nobody notices.
    const registered: string[] = [];
    const appkit = {
      server: {
        extend(register: (app: unknown) => void) {
          register({ get: (path: string) => registered.push(path), post: (path: string) => registered.push(path) });
        },
      },
    } as never;

    setupOpsRoutes(appkit, { isAdminRoute: () => false });
    expect(registered).toEqual([]);
  });

  it('registers nothing when it is handed no guard at all', () => {
    const registered: string[] = [];
    const appkit = {
      server: {
        extend(register: (app: unknown) => void) {
          register({ get: (path: string) => registered.push(path), post: (path: string) => registered.push(path) });
        },
      },
    } as never;

    setupOpsRoutes(appkit, {} as never);
    expect(registered).toEqual([]);
  });

  it('registers every path in the register once the guard does cover them', () => {
    const registered: string[] = [];
    const appkit = {
      server: {
        extend(register: (app: unknown) => void) {
          register({ get: (path: string) => registered.push(path), post: (path: string) => registered.push(path) });
        },
      },
    } as never;

    setupOpsRoutes(appkit, { isAdminRoute });
    expect(registered).toEqual([...OPS_ROUTES]);
  });

  /**
   * And says so, which is not decoration.
   *
   * This function failed loudly and succeeded in silence, while the Monitoring
   * routes beside it announced themselves on success. A boot log therefore had a
   * `[monitoring]` line and no `[ops]` line whether Ops had registered or not,
   * and reading that as a half-landed deploy is the obvious reading. It cost
   * somebody a look through the logs for a problem that was not there.
   */
  it('announces itself on the success path, the way Monitoring does', () => {
    const said: string[] = [];
    const log = console.log;
    console.log = (line: string) => said.push(line);
    try {
      setupOpsRoutes({ server: { extend: () => {} } } as never, { isAdminRoute });
    } finally {
      console.log = log;
    }
    expect(said.filter((line) => line.startsWith('[ops] Registered'))).toHaveLength(1);
  });
});
