/**
 * What the administrator settings send over the wire.
 *
 * Shared so the editor and the routes cannot disagree about the shape of a row.
 *
 * ONE FACT PER ROW: who they are, where the row came from, and what may be done to
 * it. This file used to carry a second fact, the Unity Catalog access behind the
 * role, because adding an administrator also granted on the telemetry schema and
 * the `system.billing` tables. It does not any more. The grant on `system` needs
 * an account admin who is also a metastore admin, so the ordinary case was a
 * PERMISSION_DENIED beside a name and a workflow that read as blocked, for access
 * that was never a prerequisite for the role. An administrator is a row in
 * Lakebase, and this screen is user management.
 *
 * Nothing in this file decides anything. The origin of a row and whether it may be
 * removed are decided on the server, because the button the screen draws and the
 * refusal the route makes have to be one fact rather than two implementations of
 * one rule.
 */

/**
 * One row of the list, with where it came from.
 *
 * `origin` is the whole of what the row can do: a seed row is deployment
 * configuration and cannot be removed from this screen, an added row can.
 */
export interface AdminListEntry {
  email: string;
  origin: 'seed' | 'added';
  /** Who added them, for an added row. Empty for a seed row. */
  addedBy: string;
  /** When, for an added row. Empty for a seed row. */
  addedAt: string;
  /** Whether this row is the person reading the screen. */
  isYou: boolean;
  removable: boolean;
}

export interface AdminListPayload {
  entries: AdminListEntry[];
  /** False when the stored half could not be read. The screen says so. */
  addedAdminsReadable: boolean;
  seedAdminCount: number;
}
