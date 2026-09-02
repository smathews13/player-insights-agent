
import {
  CostBudgetsSchema,
  attributableCostBudgets,
  forgetAppBudgetStatus,
  readCostBudgets,
  userEmail,
  writeCostBudgets
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
import "./chunk-5DRRUJAY.mjs";
import "./chunk-7DTM6FIL.mjs";
import "./chunk-LLUDDZ3A.mjs";

// server/routes/cost-budgets-routes.ts
function setupCostBudgetsRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/admin/cost-budgets", async (_req, res) => {
      const stored = await readCostBudgets(appkit, { maxAgeMs: 0 });
      res.json({ budgets: stored.budgets, readable: stored.readable });
    });
    app.put("/api/admin/cost-budgets", async (req, res) => {
      const parsed = CostBudgetsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_cost_budgets", detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const budgets = await writeCostBudgets(appkit, attributableCostBudgets(parsed.data), actor);
        forgetAppBudgetStatus();
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: "cost-budgets-updated",
          subject: "cost-budgets",
          detail: "Updated the monthly app budget and advisory resource budgets."
        });
        res.json({ budgets, readable: true });
      } catch (error) {
        res.status(503).json({
          error: "cost_budgets_store_unavailable",
          detail: `The budgets were not saved: ${error.message}`
        });
      }
    });
  });
}
export {
  setupCostBudgetsRoutes
};
