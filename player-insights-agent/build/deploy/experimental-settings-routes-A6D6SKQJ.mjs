
import {
  SettingsRevisionConflict,
  readVersionedSettings,
  userEmail,
  writeVersionedSettingsPatch
} from "./chunk-7SO7JJCQ.mjs";
import "./chunk-4IYCA3Q2.mjs";
import "./chunk-RPJTQHME.mjs";
import "./chunk-YG4YL534.mjs";
import "./chunk-VHHJDNLO.mjs";
import {
  recordAdminAction
} from "./chunk-XIJCYHNA.mjs";
import "./chunk-FHPVN4JA.mjs";
import "./chunk-LVHEQTRD.mjs";
import "./chunk-JLYA46HN.mjs";
import {
  external_exports
} from "./chunk-5DRRUJAY.mjs";
import {
  appTable
} from "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// shared/experimental-settings-browser.ts
var NO_EXPERIMENTS = {
  benchmarkLab: false,
  egressControls: false,
  forecasting: false
};

// shared/experimental-settings.ts
var ExperimentalSettingsSchema = external_exports.object({
  benchmarkLab: external_exports.boolean().default(false),
  egressControls: external_exports.boolean().default(false),
  forecasting: external_exports.boolean().default(false)
});
var ExperimentalSettingsPatchSchema = external_exports.strictObject({
  benchmarkLab: external_exports.boolean().optional(),
  egressControls: external_exports.boolean().optional(),
  forecasting: external_exports.boolean().optional()
});

// server/lib/experimental-settings-store.ts
var KEY = "app-global";
var EXPERIMENTAL_SETTINGS_TABLE = appTable("experimental_settings");
var STORE = {
  table: EXPERIMENTAL_SETTINGS_TABLE,
  key: KEY,
  defaults: { ...NO_EXPERIMENTS },
  parse: (value) => ExperimentalSettingsSchema.parse(value)
};
var cache = /* @__PURE__ */ new WeakMap();
var EXPERIMENTAL_SETTINGS_TTL_MS = 15e3;
function forgetExperimentalSettings() {
  cache = /* @__PURE__ */ new WeakMap();
}
async function readExperimentalSettings(client, options = {}) {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? EXPERIMENTAL_SETTINGS_TTL_MS;
  const cached = cache.get(client);
  if (cached && maxAge > 0 && now - cached.at < maxAge) return cached.document;
  const document = await readVersionedSettings(client, STORE);
  cache.set(client, { document, at: now });
  return document;
}
async function writeExperimentalSettings(client, patch, revision, updatedBy) {
  const document = await writeVersionedSettingsPatch(client, STORE, patch, revision, updatedBy);
  forgetExperimentalSettings();
  return document;
}

// server/routes/experimental-settings-routes.ts
var ExperimentalSettingsWrite = external_exports.strictObject({
  revision: external_exports.number().int().nonnegative(),
  patch: ExperimentalSettingsPatchSchema
});
function setupExperimentalSettingsRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/experimental-settings", async (_req, res) => {
      try {
        res.json(await readExperimentalSettings(appkit, { maxAgeMs: 0 }));
      } catch (error) {
        res.status(503).json({
          error: "experimental_settings_store_unavailable",
          detail: `Experimental settings could not be read from Lakebase: ${error.message}`
        });
      }
    });
    app.put("/api/admin/experimental-settings", async (req, res) => {
      const parsed = ExperimentalSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_experimental_settings", detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      let document;
      try {
        document = await writeExperimentalSettings(appkit, parsed.data.patch, parsed.data.revision, actor);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? "experimental_settings_conflict" : "experimental_settings_store_unavailable",
          detail: conflict ? error.message : `The settings were not saved: ${error.message}`
        });
        return;
      }
      try {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: "experimental-settings-updated",
          subject: "experimental-settings",
          detail: "Updated deployment-wide experimental feature visibility."
        });
      } catch (error) {
        console.warn("[experimental-settings] Saved settings, but could not write the admin audit row:", error);
      }
      res.json(document);
    });
  });
}
export {
  setupExperimentalSettingsRoutes
};
