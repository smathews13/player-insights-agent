
import {
  ExpiringLruCache
} from "./chunk-YG4YL534.mjs";

// server/lib/deadline.ts
async function withDeadline(work, ms, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// shared/access-gate.ts
var ACCESS_GATE_ENABLED = false;

// server/routes/execution-identity.ts
var ACCESS_MODES = ["service-principal", "user-verified", "skipped"];
function isAccessMode(value) {
  return typeof value === "string" && ACCESS_MODES.includes(value);
}
function appServicePrincipal() {
  return process.env.DATABRICKS_CLIENT_ID?.trim() || null;
}
var servingPrincipal = null;
function observedServingPrincipal() {
  return servingPrincipal;
}
var ACCESS_DECISION_TTL_MS = 5 * 6e4;
var ACCESS_DECISION_CACHE_MAX_ENTRIES = 2048;
var decisions = new ExpiringLruCache(ACCESS_DECISION_CACHE_MAX_ENTRIES, ACCESS_DECISION_TTL_MS);
function decisionKey(email) {
  return email.trim().toLowerCase();
}
function declareAccessMode(email, mode, detail, now = Date.now()) {
  if (mode === "user-verified") {
    throw new Error(
      "user-verified is established by running the access checks, not by declaring it. Call recordVerifiedAccess with the outcome of a real check."
    );
  }
  const decision = { mode, decidedAt: new Date(now).toISOString(), detail };
  decisions.set(decisionKey(email), decision, now);
  return decision;
}
function recordVerifiedAccess(email, detail, now = Date.now()) {
  const decision = { mode: "user-verified", decidedAt: new Date(now).toISOString(), detail };
  decisions.set(decisionKey(email), decision, now);
  return decision;
}
function accessModeFor(email, now = Date.now()) {
  return decisions.get(decisionKey(email), now)?.mode ?? "service-principal";
}
function accessDecisionFor(email, now = Date.now()) {
  return decisions.get(decisionKey(email), now) ?? null;
}
function recordedAccessMode(email, gate = ACCESS_GATE_ENABLED, now = Date.now()) {
  if (gate) return accessModeFor(email, now);
  return accessDecisionFor(email, now)?.mode ?? null;
}
function executionIdentityColumns(email, execution) {
  const serving = observedServingPrincipal();
  return [
    appServicePrincipal(),
    serving?.id ?? null,
    serving?.observedAt ?? null,
    recordedAccessMode(email),
    execution?.mode ?? null,
    execution?.verified ?? null
  ];
}

export {
  withDeadline,
  isAccessMode,
  appServicePrincipal,
  observedServingPrincipal,
  declareAccessMode,
  recordVerifiedAccess,
  accessModeFor,
  accessDecisionFor,
  executionIdentityColumns
};
