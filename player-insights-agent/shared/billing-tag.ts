/**
 * The billing tag this app writes onto resources it manages, and the predicate
 * Ops uses when it reads `system.billing.usage`.
 *
 * Key and value are this pair on purpose: an earlier revision used key
 * `astrolabe` / value `true`, which read as a flag rather than a billing
 * dimension. `system_billing=astrolabe` is what a person looking at usage rows
 * can match by eye.
 */
export const BILLING_TAG = { key: 'system_billing', value: 'astrolabe' } as const;

/** The retired key. Still stripped on write so a resource is not left with both. */
export const RETIRED_BILLING_TAG_KEY = 'astrolabe';

export function billingTagPair(): string {
  return `${BILLING_TAG.key}=${BILLING_TAG.value}`;
}

/**
 * Whether this app's own record carries {@link BILLING_TAG}.
 *
 * Separate from billed usage. Databricks Apps tags are organizational and may
 * not appear on `system.billing.usage` rows, so a missing spend figure is not
 * evidence the tag is absent.
 */
export type AppBillingTagState = 'matched' | 'missing' | 'unverified';
