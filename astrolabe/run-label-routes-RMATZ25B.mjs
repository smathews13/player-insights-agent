
import {
  readRunLabelOverride,
  userEmail,
  writeRunLabelOverride
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
