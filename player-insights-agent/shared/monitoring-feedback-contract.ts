import type { Role } from './user-roster-contract';

export const MONITORING_FEEDBACK_SCHEMA_REVISION = 2;
/** One modal page: five compact rows fit without crowding the normal viewport. */
export const MONITORING_FEEDBACK_PAGE_SIZE = 5;

export type MonitoringFeedbackDirection = 'up' | 'down';

export interface MonitoringFeedbackRow {
  /** Append-only feedback submission id; also the second keyset field. */
  id: string;
  /** Existing Monitoring question id opened by the row. */
  questionId: string;
  conversationId: string;
  /** Existing Run Explorer answer id, when the stored feedback targets one. */
  runId: string;
  question: string;
  askedAt: string;
  /** The person who submitted this feedback, not an inferred conversation owner. */
  userEmail: string;
  role: Role;
  persona: { id: string; name: string } | null;
  organization: { domain: string; name: string };
  feedback: MonitoringFeedbackDirection;
  /** Exact written down-feedback, or null when no comment was submitted. */
  comment: string | null;
  /** Canonical feedback.created_at value and the first keyset field. */
  submittedAt: string;
}

export interface MonitoringFeedbackOption {
  value: string;
  label: string;
  count: number;
}

export interface MonitoringFeedbackPayload {
  schemaRevision: typeof MONITORING_FEEDBACK_SCHEMA_REVISION;
  readAt: string;
  /** Changes when the matching feedback corpus changes. */
  dataRevision: string;
  /** Changes when role or persona evidence represented by this corpus changes. */
  identityRevision: string;
  summary: {
    total: number;
    helpful: number;
    notHelpful: number;
    /** Submitted feedback rows carrying a non-empty written comment. */
    comments: number;
  };
  rows: MonitoringFeedbackRow[];
  filters: {
    users: MonitoringFeedbackOption[];
    roles: MonitoringFeedbackOption[];
    personas: MonitoringFeedbackOption[];
    organizations: MonitoringFeedbackOption[];
  };
  pagination: {
    pageSize: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}
