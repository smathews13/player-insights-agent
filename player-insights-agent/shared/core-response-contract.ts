/** Versions for the three core agent payloads that previously had no marker. */
export const ANSWER_SCHEMA_VERSION = 'pia.answer/1' as const;
export const PLAN_SCHEMA_VERSION = 'pia.plan/1' as const;
export const CLARIFICATION_SCHEMA_VERSION = 'pia.clarification/1' as const;

export type CoreResponseSchemaVersion =
  | typeof ANSWER_SCHEMA_VERSION
  | typeof PLAN_SCHEMA_VERSION
  | typeof CLARIFICATION_SCHEMA_VERSION;
