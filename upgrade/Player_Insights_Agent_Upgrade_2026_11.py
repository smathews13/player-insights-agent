# Databricks notebook source
# MAGIC %md
# MAGIC # Player Insights Agent: one-time upgrade (November 2026 security release)
# MAGIC
# MAGIC Run this once, after the app has taken the new code with **Deploy from Git**. It
# MAGIC applies the access settings a Git deploy cannot, then reports what it finds. No bundle
# MAGIC deploy is needed, and every step is safe to repeat.
# MAGIC
# MAGIC 1. The app's own service principal gets `CAN_MANAGE` on the app, so the Identity screen
# MAGIC    can read the live member list.
# MAGIC 2. Your app groups get `CAN_USE` on the app and on its SQL warehouse, and `CAN_RUN` on
# MAGIC    its Genie spaces.
# MAGIC 3. The agent's MLflow experiment is limited to the app, the endpoint's owner and the
# MAGIC    admin group. Traces hold each person's questions, so the workspace-wide `users`
# MAGIC    grant is removed.
# MAGIC 4. The agent endpoint stops writing its request log (questions and answers stay in
# MAGIC    Lakebase), and gets usage tracking and rate limits where the workspace supports them.
# MAGIC 5. A read-only report of who can reach each object.
# MAGIC
# MAGIC **Who runs it:** someone with `CAN_MANAGE` on the app, the SQL warehouse, the Genie
# MAGIC spaces, the MLflow experiment and the serving endpoint, typically a workspace admin.
# MAGIC
# MAGIC **How:** fill in the widgets above, run all with **Apply changes** set to `no` to
# MAGIC preview, then set it to `yes` and run all again.

# COMMAND ----------

import json
import os

from databricks.sdk import WorkspaceClient

try:
    dbutils  # noqa: B018  (present in a Databricks notebook)
except NameError:
    dbutils = None


def widget(name: str, default: str, label: str, choices: list[str] | None = None) -> str:
    if dbutils is None:
        return os.environ.get(f"PIA_UPGRADE_{name.upper()}", default).strip()
    if choices:
        dbutils.widgets.dropdown(name, default, choices, label)
    else:
        dbutils.widgets.text(name, default, label)
    return dbutils.widgets.get(name).strip()


APP_NAME = widget("app_name", "player-insights-agent", "1. App name")
ENGINEER_GROUP = widget("engineer_group", "", "2. Engineer group")
EXEC_GROUP = widget("exec_group", "", "3. Executive group")
ADMIN_GROUP = widget("admin_group", "", "4. Admin group")
GENIE_SPACES = widget("genie_space_ids", "", "5. Genie space IDs (comma-separated)")
APPLY = widget("apply", "no", "6. Apply changes", ["no", "yes"]) == "yes"

USER_CALLS_PER_MINUTE = 60
ENDPOINT_CALLS_PER_MINUTE = 2000
EVERYONE = {"users", "account users"}

w = WorkspaceClient()
GROUPS = list(dict.fromkeys(g for g in (ENGINEER_GROUP, EXEC_GROUP, ADMIN_GROUP) if g))
SPACES = [s.strip() for s in GENIE_SPACES.split(",") if s.strip()]
PROBLEMS: list[str] = []


def step(title: str) -> None:
    print(f"\n==> {title}")


def api(method: str, path: str, body: dict | None = None) -> dict:
    return w.api_client.do(method, path, body=body) or {}


# COMMAND ----------

# MAGIC %md ## Find the app's resources

# COMMAND ----------

app = api("GET", f"/api/2.0/apps/{APP_NAME}")
APP_SP = app.get("service_principal_client_id") or ""
WAREHOUSE = ""
ENDPOINT = ""
for resource in app.get("resources") or []:
    WAREHOUSE = WAREHOUSE or (resource.get("sql_warehouse") or {}).get("id", "")
    ENDPOINT = ENDPOINT or (resource.get("serving_endpoint") or {}).get("name", "")

endpoint = api("GET", f"/api/2.0/serving-endpoints/{ENDPOINT}") if ENDPOINT else {}
ENDPOINT_CREATOR = endpoint.get("creator") or ""
EXPERIMENT = ""
for entity in (endpoint.get("config") or {}).get("served_entities") or []:
    EXPERIMENT = EXPERIMENT or (entity.get("environment_vars") or {}).get(
        "MLFLOW_EXPERIMENT_ID", ""
    )

step("What this upgrade will touch")
print(f"  app               {APP_NAME} (service principal {APP_SP or 'not found'})")
print(f"  SQL warehouse     {WAREHOUSE or 'not found'}")
print(f"  serving endpoint  {ENDPOINT or 'not found'} (owner {ENDPOINT_CREATOR or 'unknown'})")
print(f"  MLflow experiment {EXPERIMENT or 'not found'}")
print(f"  Genie spaces      {', '.join(SPACES) or 'none given'}")
print(f"  app groups        {', '.join(GROUPS) or 'none given'}")
print(f"  mode              {'APPLY' if APPLY else 'preview only, nothing will change'}")
if not APP_SP or not ENDPOINT:
    raise SystemExit(
        f"App '{APP_NAME}' has no service principal or serving endpoint. Check the app name."
    )
if not GROUPS:
    print("  NOTE: no groups given, so no group grants will be made.")

# COMMAND ----------

# MAGIC %md ## Apply the access settings

# COMMAND ----------

RANK = {
    "CAN_VIEW": 1,
    "CAN_READ": 1,
    "CAN_USE": 2,
    "CAN_RUN": 2,
    "CAN_QUERY": 2,
    "CAN_EDIT": 3,
    "CAN_MONITOR": 3,
    "CAN_MANAGE": 4,
    "IS_OWNER": 5,
}
KINDS = ("user_name", "group_name", "service_principal_name")


def acl(object_type: str, object_id: str) -> list[dict]:
    return (
        api("GET", f"/api/2.0/permissions/{object_type}/{object_id}").get("access_control_list")
        or []
    )


def held(entries: list[dict]) -> dict[tuple[str, str], int]:
    best: dict[tuple[str, str], int] = {}
    for entry in entries:
        for kind in KINDS:
            name = str(entry.get(kind) or "").strip().lower()
            if name:
                rank = max(
                    (
                        RANK.get(p.get("permission_level", ""), 0)
                        for p in entry.get("all_permissions") or []
                    ),
                    default=0,
                )
                best[(kind, name)] = max(best.get((kind, name), 0), rank)
    return best


def ensure(
    object_type: str, object_id: str, wanted: list[tuple[str, str, str]], title: str
) -> None:
    """Grant each (kind, name, level) at least that level. Merges; never removes anyone."""

    step(title)
    try:
        current = held(acl(object_type, object_id))
        missing = [
            (k, n, lvl) for k, n, lvl in wanted if current.get((k, n.lower()), 0) < RANK[lvl]
        ]
        if not missing:
            print("  already in place")
            return
        for _kind, name, level in missing:
            print(f"  {'granting' if APPLY else 'would grant'} {level} to {name}")
        if not APPLY:
            return
        body = {
            "access_control_list": [
                {kind: name, "permission_level": level} for kind, name, level in missing
            ]
        }
        api("PATCH", f"/api/2.0/permissions/{object_type}/{object_id}", body)
        after = held(acl(object_type, object_id))
        still = [n for k, n, lvl in wanted if after.get((k, n.lower()), 0) < RANK[lvl]]
        if still:
            raise RuntimeError("did not verify for " + ", ".join(still))
        print("  verified")
    except Exception as error:  # noqa: BLE001  (report and continue with the next step)
        PROBLEMS.append(f"{title}: {error}")
        print(f"  WARNING: {error}")


ensure(
    "apps",
    APP_NAME,
    [("service_principal_name", APP_SP, "CAN_MANAGE")],
    "The app's own service principal",
)
ensure("apps", APP_NAME, [("group_name", g, "CAN_USE") for g in GROUPS], "App groups on the app")
if WAREHOUSE:
    ensure(
        "warehouses",
        WAREHOUSE,
        [("group_name", g, "CAN_USE") for g in GROUPS],
        "App groups on the SQL warehouse",
    )
for space in SPACES:
    ensure(
        "genie",
        space,
        [("group_name", g, "CAN_RUN") for g in GROUPS],
        f"App groups on Genie space {space}",
    )

# COMMAND ----------

# MAGIC %md ## Limit the MLflow experiment

# COMMAND ----------

if EXPERIMENT:
    wanted = [("service_principal_name", APP_SP, "CAN_EDIT")]
    if ENDPOINT_CREATOR:
        kind = "user_name" if "@" in ENDPOINT_CREATOR else "service_principal_name"
        wanted.append((kind, ENDPOINT_CREATOR, "CAN_EDIT"))
    if ADMIN_GROUP:
        wanted.append(("group_name", ADMIN_GROUP, "CAN_READ"))
    ensure("experiments", EXPERIMENT, wanted, "Who can read traces")

    step("Removing the workspace-wide 'users' grant from the experiment")
    try:
        entries = acl("experiments", EXPERIMENT)
        direct = [
            e
            for e in entries
            if e.get("group_name") == "users"
            and any(not p.get("inherited") for p in e.get("all_permissions") or [])
        ]
        if not direct:
            print("  no direct 'users' grant")
        elif not APPLY:
            print("  would remove the direct 'users' grant and keep every other entry")
        elif held(entries).get(("service_principal_name", APP_SP.lower()), 0) < RANK["CAN_EDIT"]:
            raise RuntimeError("the app's grant is not in place, so 'users' was left as it is")
        else:
            kept = []
            for entry in entries:
                if entry.get("group_name") == "users":
                    continue
                principal = {k: entry[k] for k in KINDS if entry.get(k)}
                kept += [
                    {**principal, "permission_level": p["permission_level"]}
                    for p in entry.get("all_permissions") or []
                    if not p.get("inherited")
                ]
            api(
                "PUT",
                f"/api/2.0/permissions/experiments/{EXPERIMENT}",
                {"access_control_list": kept},
            )
            print("  removed; every other entry kept")
        inherited = [
            e
            for e in acl("experiments", EXPERIMENT)
            if e.get("group_name") == "users"
            and any(p.get("inherited") for p in e.get("all_permissions") or [])
        ]
        if inherited:
            print("  NOTE: 'users' still reaches the experiment through its parent folder.")
            print("  Move the experiment to a folder that is not shared with everyone, or remove")
            print("  the grant on the folder.")
    except Exception as error:  # noqa: BLE001
        PROBLEMS.append(f"Experiment 'users' grant: {error}")
        print(f"  WARNING: {error}")

# COMMAND ----------

# MAGIC %md ## Endpoint policy: no request log, usage tracking and rate limits

# COMMAND ----------

OPTIONAL = {"usage tracking": "usage_tracking_config", "rate limits": "rate_limits"}


def policy_view(config: dict) -> dict:
    return {
        "request_log": bool((config.get("inference_table_config") or {}).get("enabled")),
        "usage_tracking": bool((config.get("usage_tracking_config") or {}).get("enabled")),
        "rate_limits": sorted(
            (r.get("key"), int(r.get("calls") or 0)) for r in config.get("rate_limits") or []
        ),
    }


step(f"AI Gateway policy on {ENDPOINT}")
try:
    current = endpoint.get("ai_gateway") or {}
    target = json.loads(json.dumps(current))
    target["inference_table_config"] = {"enabled": False}
    target["usage_tracking_config"] = {"enabled": True}
    target["rate_limits"] = [
        {"calls": USER_CALLS_PER_MINUTE, "key": "user", "renewal_period": "minute"},
        {"calls": ENDPOINT_CALLS_PER_MINUTE, "key": "endpoint", "renewal_period": "minute"},
        *[
            r
            for r in current.get("rate_limits") or []
            if str(r.get("key", "")).lower() not in {"user", "endpoint"}
        ],
    ]
    print(f"  now:    {policy_view(current)}")
    print(f"  target: {policy_view(target)}")
    if policy_view(current) == policy_view(target):
        print("  already in place")
    elif APPLY:
        refused: list[str] = []
        while True:
            try:
                api("PUT", f"/api/2.0/serving-endpoints/{ENDPOINT}/ai-gateway", target)
                break
            except Exception as error:  # noqa: BLE001
                text = str(error).lower()
                feature = (
                    next((f for f in OPTIONAL if f in text), None)
                    if "not currently supported" in text
                    else None
                )
                if feature is None or feature in refused:
                    raise
                refused.append(feature)
                key = OPTIONAL[feature]
                if key in current:
                    target[key] = current[key]
                else:
                    target.pop(key, None)
        print("  applied")
        if refused:
            print(f"  This workspace does not support {' and '.join(refused)} on this endpoint")
            print("  type; set them on the AI Gateway model service the agent calls instead.")
except Exception as error:  # noqa: BLE001
    PROBLEMS.append(f"Endpoint policy: {error}")
    print(f"  WARNING: {error}")

# COMMAND ----------

# MAGIC %md ## Report: who can reach each object (read-only)

# COMMAND ----------


def report(label: str, object_type: str, object_id: str) -> None:
    try:
        entries = acl(object_type, object_id)
    except Exception as error:  # noqa: BLE001
        print(f"  ?     {label}: could not read ({error})")
        return
    everyone = sorted({e.get("group_name") for e in entries if e.get("group_name") in EVERYONE})
    people = sorted({e["user_name"] for e in entries if e.get("user_name")})
    groups = sorted(
        {
            e["group_name"]
            for e in entries
            if e.get("group_name") and e.get("group_name") not in EVERYONE | {"admins"}
        }
    )
    status = "CHECK" if everyone else "ok"
    print(f"  {status:5} {label}")
    print(f"        groups: {', '.join(groups) or 'none'}")
    if everyone:
        print(f"        open to everyone through: {', '.join(everyone)}")
    if people:
        print(
            f"        people granted directly: {len(people)} (grant groups instead where you can)"
        )


step("Access report")
report(f"app {APP_NAME}", "apps", APP_NAME)
if WAREHOUSE:
    report(f"SQL warehouse {WAREHOUSE}", "warehouses", WAREHOUSE)
for space in SPACES:
    report(f"Genie space {space}", "genie", space)
if EXPERIMENT:
    report(f"MLflow experiment {EXPERIMENT}", "experiments", EXPERIMENT)
report(f"serving endpoint {ENDPOINT}", "serving-endpoints", endpoint.get("id", ENDPOINT))
latest = api("GET", f"/api/2.0/serving-endpoints/{ENDPOINT}")
gateway_log = policy_view(latest.get("ai_gateway") or {})["request_log"]
legacy_log = bool(((latest.get("config") or {}).get("auto_capture_config") or {}).get("enabled"))
request_log_on = gateway_log or legacy_log
request_log_status = "CHECK" if request_log_on else "ok"
print(f"  {request_log_status:5} endpoint request log {'ON' if request_log_on else 'off'}")
if legacy_log:
    print("        the endpoint still writes an inference table through its older capture")
    print("        setting. Turn it off on the endpoint's page (Edit endpoint, Inference tables);")
    print("        changing it redeploys the endpoint.")
    PROBLEMS.append("Endpoint request log: the older inference table capture is still on")

step("Result")
if not APPLY:
    print("  Preview only. Set 'Apply changes' to yes and run all again to make these changes.")
elif PROBLEMS:
    print("  Finished with steps to repeat:")
    for problem in PROBLEMS:
        print(f"  - {problem}")
    raise SystemExit("Fix the warnings above and run the notebook again.")
else:
    print("  Upgrade complete.")
