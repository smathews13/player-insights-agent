/**
 * Whether every tab is drawn for every reader, whatever their role.
 *
 * OFF. It was a review posture so the whole app could be seen without swapping
 * accounts; a deployment with real consumers must not show them Monitoring, Ops
 * or settings they cannot use. Turning it on restores that review view without
 * touching a role check.
 *
 * It never widened permission either way. The server refuses every admin route
 * with 403, and `AdminOnly` still stands in front of Monitoring, Ops and the
 * contract page. Here rather than in `shared/` because the server must NOT agree
 * with it.
 */
export const SHOW_EVERY_TAB_TO_EVERYONE: boolean = false;

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
