/**
 * Whether every tab is drawn for every reader, whatever their role.
 *
 * ON, AND TEMPORARY. Asked for directly so the whole app can be reviewed
 * without swapping accounts to see half of it. It is a review posture and not a
 * decision about who should see what, which is why it is one exported boolean
 * with one reader rather than a deletion of the role checks: setting this to
 * false restores the previous navigation exactly, and nothing else has to be
 * remembered or put back.
 *
 * WHAT IT DOES NOT DO, which matters more than what it does:
 *
 *  - It does not widen permission. The server refuses every admin route with
 *    403 whatever this draws, and that refusal is the enforcement. Nothing here
 *    reaches the server, is sent to it, or is agreed with it.
 *  - It does not open the admin pages. `AdminOnly` still stands in front of
 *    Monitoring, Ops and App settings, so a genuine consumer who follows one of
 *    these newly-visible tabs is met by the gate panel -- "Not available on your
 *    account", one line naming the page, and the way back -- rather than by a
 *    page of failed requests. That panel is the reason unhiding the tabs is
 *    safe to do from the navigation alone.
 *
 * Here rather than in `shared/` because the server must NOT agree with it. That
 * is the opposite of `ACCESS_GATE_ENABLED`, which is in `shared/` precisely
 * because it is deployment state both halves have to read the same way. This
 * source gate is separate from the Lakebase-backed Experimental settings
 * because no runtime setting may turn a withdrawn build surface back on.
 */
export const SHOW_EVERY_TAB_TO_EVERYONE: boolean = true;

/**
 * Whether the Benchmark Lab is offered in the app at all.
 *
 * ON as the emergency gate around the operator-facing setting. The Settings
 * toggle remains off by default and decides whether this deployment shows the
 * tab, scorers and judge details. Setting this to false still removes the
 * surface without deleting its routes or data.
 *
 * While off, `/benchmarks` redirects to Ask rather than rendering the empty lab
 * or a permission gate. Server `/api/benchmarks*` routes stay registered; this
 * flag is UI visibility only.
 */
export const BENCHMARK_LAB_ENABLED: boolean = true;
