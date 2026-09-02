
import {
  ExperimentalSettingsPatchSchema,
  readExperimentalSettings,
  writeExperimentalSettings
} from "./chunk-7RFDXCFM.mjs";
import {
  SettingsRevisionConflict,
  userEmail
} from "./chunk-Z54N5YP3.mjs";
import "./chunk-TPU7NP2N.mjs";
import "./chunk-Y3XGZW4B.mjs";
import "./chunk-ENWPWZ4F.mjs";
import "./chunk-VHHJDNLO.mjs";
import {
  recordAdminAction
} from "./chunk-TIMY5ERW.mjs";
import "./chunk-FHPVN4JA.mjs";
import "./chunk-JHCBSJGB.mjs";
import "./chunk-P6LGY7M5.mjs";
import {
  external_exports
} from "./chunk-5DRRUJAY.mjs";
import "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

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
