/**
 * Ask a served model for the release configuration it baked.
 *
 * This is the one surviving use of the retired preflight-shaped request. It
 * performs no dependency checks and no model turn: current model versions
 * recognize it as a compatibility request and return configuration only.
 * Keeping the request body here prevents interactive and health routes from
 * rebuilding or subtly changing that contract.
 */

export const SERVED_CONFIGURATION_RECOVERY_TIMEOUT_MS = 15_000;

export type ServedConfigurationInvoker = (payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

export async function requestServedConfiguration<T>(
  invoke: ServedConfigurationInvoker,
  parse: (response: unknown) => T[]
): Promise<T[]> {
  const response = await invoke(
    {
      input: [{ role: 'user', content: 'preflight' }],
      custom_inputs: { preflight: true },
    },
    SERVED_CONFIGURATION_RECOVERY_TIMEOUT_MS
  );
  return parse(response);
}
