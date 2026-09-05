/**
 * The billing tag this app writes onto resources it manages, and the predicate
 * Ops uses when it reads `system.billing.usage`.
 *
 * The canonical product slug is the dimension value so usage rows, bundle
 * resources, and release tooling all identify the same product.
 */
export const BILLING_TAG = { key: 'system_billing', value: 'player-insights-agent' } as const;

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
