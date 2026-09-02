
import {
  RuntimeSettingsPatchSchema,
  SettingsRevisionConflict,
  readRuntimeSettingsDocument,
  userEmail,
  writeRuntimeSettingsPatch
} from "./chunk-HKEAMEUB.mjs";
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

// server/routes/runtime-settings-routes.ts
var RuntimeSettingsWrite = external_exports.strictObject({
  revision: external_exports.number().int().nonnegative(),
  patch: RuntimeSettingsPatchSchema
});
function setupRuntimeSettingsRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/runtime-settings", async (_req, res) => {
      try {
        res.json(await readRuntimeSettingsDocument(appkit, { maxAgeMs: 0 }));
      } catch (error) {
        res.status(503).json({
          error: "runtime_settings_store_unavailable",
          detail: `Runtime settings could not be read from Lakebase: ${error.message}`
        });
      }
    });
    app.put("/api/admin/runtime-settings", async (req, res) => {
      const parsed = RuntimeSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_runtime_settings", detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      let document;
      try {
        document = await writeRuntimeSettingsPatch(appkit, parsed.data.patch, parsed.data.revision, actor);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? "runtime_settings_conflict" : "runtime_settings_store_unavailable",
          detail: conflict ? error.message : `The settings were not saved: ${error.message}`
        });
        return;
      }
      try {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: "runtime-settings-updated",
          subject: "runtime-settings",
          detail: "Updated live loop, answer presentation, and request-context settings."
        });
      } catch (error) {
        console.warn("[runtime-settings] Saved settings, but could not write the admin audit row:", error);
      }
      res.json({ ...document, appliesNow: true });
    });
  });
}
export {
  setupRuntimeSettingsRoutes
};
