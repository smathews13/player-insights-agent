
import {
  readRunLabelOverride,
  userEmail,
  writeRunLabelOverride
} from "./chunk-XO3UIQDJ.mjs";
import "./chunk-4IYCA3Q2.mjs";
import "./chunk-RPJTQHME.mjs";
import "./chunk-YG4YL534.mjs";
import "./chunk-VHHJDNLO.mjs";
import {
  recordAdminAction
} from "./chunk-XIJCYHNA.mjs";
import "./chunk-FHPVN4JA.mjs";
import "./chunk-P3NCP4CN.mjs";
import "./chunk-JLYA46HN.mjs";
import {
  external_exports
} from "./chunk-5DRRUJAY.mjs";
import "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// server/routes/run-label-routes.ts
var OverlayBody = external_exports.object({
  status: external_exports.enum(["complete", "partial", "failed"]).optional(),
  rating: external_exports.enum(["unrated", "up", "down"]).optional()
});
function setupRunLabelRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/admin/run-labels/:runId", async (req, res) => {
      const runId = req.params.runId?.trim() ?? "";
      if (!runId) {
        res.status(400).json({ error: "run_id_required" });
        return;
      }
      try {
        const overlay = await readRunLabelOverride(appkit.lakebase.query.bind(appkit.lakebase), runId);
        if (!overlay) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.json(overlay);
      } catch (error) {
        res.status(503).json({
          error: "run_labels_unreadable",
          detail: error.message
        });
      }
    });
    app.put("/api/admin/run-labels/:runId", async (req, res) => {
      const runId = req.params.runId?.trim() ?? "";
      const parsed = OverlayBody.safeParse(req.body);
      if (!runId || !parsed.success || parsed.data.status === void 0 && parsed.data.rating === void 0) {
        res.status(400).json({ error: "invalid_run_labels" });
        return;
      }
      const actor = userEmail(req);
      try {
        const overlay = await writeRunLabelOverride(appkit.lakebase.query.bind(appkit.lakebase), {
          runId,
          actor,
          ...parsed.data
        });
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: "run-labels-updated",
          subject: runId,
          detail: `Updated run rail labels${parsed.data.status ? ` outcome=${parsed.data.status}` : ""}${parsed.data.rating ? ` rating=${parsed.data.rating}` : ""}.`
        });
        res.json(overlay);
      } catch (error) {
        res.status(503).json({
          error: "run_labels_not_saved",
          detail: error.message
        });
      }
    });
  });
}
export {
  setupRunLabelRoutes
};
