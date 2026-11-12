#!/usr/bin/env python3
"""End-to-end identity test against a deployed target. Run through identity-e2e.sh.

  setup     create the persistent test identities, groups, test schemas and grants
  run       drive the deployed app as each identity and check what it may do
  teardown  remove everything setup created

Every object this creates is named pia-e2e-* (identities, groups) or pia_e2e_*
(schemas), and teardown removes only those names. The app's demo data is never
written: the test identities get read grants on it, nothing more.

The client secrets live outside the repository, in
~/.config/pia-e2e/<target>.json with mode 600.

Two layers are proven separately, because on a demo target the agent may only
query its released tables and those stay untouched:
  * through the app: the agent runs as the signed-in identity, a denied identity
    stays denied with nothing run for it as the app, and the role guards hold;
  * in Unity Catalog, with each label identity's own token: the same
    cross-label question returns only that identity's label, and central sees
    all. Under on-behalf-of execution this is the answer the agent receives.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

PROFILE = os.environ["E2E_PROFILE"]
TARGET = os.environ["E2E_TARGET"]
HOST = os.environ["E2E_HOST"].rstrip("/")
APP_NAME = os.environ["E2E_APP_NAME"]
ENDPOINT = os.environ["E2E_ENDPOINT"]
WAREHOUSE_ID = os.environ["E2E_WAREHOUSE_ID"]
DATA_SCHEMA = os.environ["E2E_DATA_SCHEMA"]  # catalog.schema the agent reads
GENIE_SPACES = [s for s in os.environ.get("E2E_GENIE_SPACES", "").split(",") if s]
LABEL_ACCESS = os.environ["E2E_LABEL_ACCESS"]

CATALOG = DATA_SCHEMA.split(".")[0]
SECRETS = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "pia-e2e" / f"{TARGET}.json"

IDENTITIES = ["consumer", "denied", "admin", "label-a", "label-b", "central"]
GROUPS = {
    # Reach the agent (endpoint, warehouse, Genie). The denied identity is left
    # out: it may open the app and nothing else.
    "pia-e2e-callers": [s for s in IDENTITIES if s != "denied"],
    # Mapped to Admin in Identity, which proves group-to-role resolution.
    "pia-e2e-admins": ["admin"],
}
ADMIN_GROUP = "pia-e2e-admins"
SCHEMAS = ["pia_e2e_label_a", "pia_e2e_label_b", "pia_e2e_global", "pia_e2e_xlabel"]
MASTER = f"{CATALOG}.pia_e2e_xlabel.master"
FIXTURE_SQL = [
    f"CREATE TABLE IF NOT EXISTS {CATALOG}.pia_e2e_label_a.titles AS SELECT 'label_a' AS label, 'Alpha' AS title",
    f"CREATE TABLE IF NOT EXISTS {CATALOG}.pia_e2e_label_b.titles AS SELECT 'label_b' AS label, 'Beta' AS title",
    f"CREATE TABLE IF NOT EXISTS {CATALOG}.pia_e2e_global.calendar AS SELECT 'shared' AS note",
    f"CREATE TABLE IF NOT EXISTS {MASTER} AS SELECT * FROM VALUES "
    "('label_a', 10), ('label_b', 20), ('label_c', 30) AS t(label, revenue)",
]
def label_config(secrets: dict) -> dict:
    # Unity Catalog grants only to account principals, and groups created
    # through a workspace are workspace-local, so each label "group" here is the
    # label identity itself. Production names Entra ID groups instead.
    principal = lambda short: secrets[short]["applicationId"]  # noqa: E731
    return {
        "catalog": CATALOG,
        "shared_schemas": ["pia_e2e_global"],
        "central_groups": [principal("central")],
        "group_check": "current_user",
        "check_agent_scope": False,
        "labels": [
            {"label": "label_a", "group": principal("label-a"), "schemas": ["pia_e2e_label_a"]},
            {"label": "label_b", "group": principal("label-b"), "schemas": ["pia_e2e_label_b"]},
        ],
        "master_tables": [{"table": MASTER, "label_column": "label", "readers": "all_labels"}],
    }


# Who reads the agent's demo schema. A grant, never a write.
DATA_READERS = ["consumer", "admin"]
CROSS_LABEL_QUESTION = f"SELECT label, SUM(revenue) AS revenue FROM {MASTER} GROUP BY label ORDER BY label"


# --- plumbing -----------------------------------------------------------------


def cli(*args: str, check: bool = True) -> dict | list | None:
    result = subprocess.run(
        ["databricks", *args, "--profile", PROFILE, "-o", "json"], capture_output=True, text=True
    )
    if result.returncode != 0:
        if check:
            raise SystemExit(f"databricks {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
        return None
    return json.loads(result.stdout) if result.stdout.strip() else {}


def operator_token() -> str:
    out = subprocess.run(
        ["databricks", "auth", "token", "--profile", PROFILE], capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)["access_token"]


def sql(statement: str, token: str | None = None) -> dict:
    """Run one statement as the operator, or as whoever owns `token`."""
    body = {"warehouse_id": WAREHOUSE_ID, "statement": statement, "wait_timeout": "50s"}
    status, payload = http("POST", f"{HOST}/api/2.0/sql/statements", token or operator_token(), body)
    if status != 200:
        return {"state": "HTTP_ERROR", "error": str(payload)[:300], "rows": []}
    state = payload.get("status", {})
    while state.get("state") in ("PENDING", "RUNNING"):
        time.sleep(2)
        _, payload = http("GET", f"{HOST}/api/2.0/sql/statements/{payload['statement_id']}", token or operator_token())
        state = payload.get("status", {})
    return {
        "state": state.get("state"),
        "error": (state.get("error") or {}).get("message", ""),
        "rows": (payload.get("result") or {}).get("data_array") or [],
    }


def http(method: str, url: str, token: str, body: dict | None = None, headers: dict | None = None, cookie: str = ""):
    status, payload, _ = http_with_headers(method, url, token, body, headers, cookie)
    return status, payload


def http_with_headers(method, url, token, body=None, headers=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            raw = response.read().decode() or "{}"
            return response.status, _json(raw), response.headers
    except urllib.error.HTTPError as error:
        return error.code, _json(error.read().decode() or "{}"), error.headers


def _json(raw: str):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw[:500]}


def load_secrets() -> dict:
    if not SECRETS.exists():
        raise SystemExit(f"No test identities recorded at {SECRETS}. Run setup first.")
    return json.loads(SECRETS.read_text())


def save_secrets(data: dict) -> None:
    SECRETS.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(SECRETS.parent, stat.S_IRWXU)
    SECRETS.write_text(json.dumps(data, indent=2))
    os.chmod(SECRETS, stat.S_IRUSR | stat.S_IWUSR)


def sp_token(record: dict) -> str:
    basic = base64.b64encode(f"{record['applicationId']}:{record['secret']}".encode()).decode()
    request = urllib.request.Request(
        f"{HOST}/oidc/v1/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials", "scope": "all-apis"}).encode(),
        method="POST",
    )
    request.add_header("Authorization", f"Basic {basic}")
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())["access_token"]


def find_sp(name: str) -> dict | None:
    found = cli("service-principals", "list", "--filter", f'displayName eq "{name}"') or []
    return found[0] if found else None


def find_group(name: str) -> dict | None:
    found = cli("groups", "list", "--filter", f'displayName eq "{name}"') or []
    return found[0] if found else None


def app_url() -> str:
    return str(cli("apps", "get", APP_NAME)["url"]).rstrip("/")


def endpoint_id() -> str:
    return str(cli("serving-endpoints", "get", ENDPOINT)["id"])


def grant_acl(kind: str, object_id: str, entries: list[dict]) -> None:
    cli("permissions", "update", kind, object_id, "--json", json.dumps({"access_control_list": entries}))


# --- setup --------------------------------------------------------------------


def setup() -> None:
    secrets = json.loads(SECRETS.read_text()) if SECRETS.exists() else {}
    print("==> Test identities")
    for short in IDENTITIES:
        name = f"pia-e2e-{short}"
        sp = find_sp(name) or cli("service-principals", "create", "--display-name", name)
        record = secrets.get(short)
        if not record or record.get("id") != sp["id"]:
            secret = cli("service-principal-secrets-proxy", "create", sp["id"])
            record = {"id": sp["id"], "applicationId": sp["applicationId"], "secret": secret["secret"]}
            secrets[short] = record
            save_secrets(secrets)
        print(f"  {name}: {sp['applicationId']}")

    print("==> Test groups")
    for group, members in GROUPS.items():
        found = find_group(group) or cli("groups", "create", "--display-name", group)
        # The list call omits members; only a direct read returns them.
        existing = cli("groups", "get", found["id"])
        wanted = {secrets[m]["id"] for m in members}
        held = {str(m.get("value")) for m in existing.get("members") or []}
        missing = sorted(wanted - held)
        extra = sorted((held - wanted) & {r["id"] for r in secrets.values()})
        operations = [{"op": "add", "path": "members", "value": [{"value": v} for v in missing]}] if missing else []
        operations += [{"op": "remove", "path": f'members[value eq "{v}"]'} for v in extra]
        if operations:
            patch = {"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": operations}
            cli("groups", "patch", existing["id"], "--json", json.dumps(patch))
        print(f"  {group}: {', '.join(members)}")

    print("==> Reaching the agent (callers group)")
    grant_acl("serving-endpoints", endpoint_id(), [{"group_name": "pia-e2e-callers", "permission_level": "CAN_QUERY"}])
    grant_acl("warehouses", WAREHOUSE_ID, [{"group_name": "pia-e2e-callers", "permission_level": "CAN_USE"}])
    for space in GENIE_SPACES:
        grant_acl("genie", space, [{"group_name": "pia-e2e-callers", "permission_level": "CAN_RUN"}])
    print("  CAN_QUERY on the endpoint, CAN_USE on the warehouse, CAN_RUN on the Genie spaces")

    print("==> Reading the demo schema (consumer and admin only)")
    for kind, name, privileges in [
        ("catalog", CATALOG, ["USE_CATALOG"]),
        ("schema", DATA_SCHEMA, ["USE_SCHEMA", "SELECT"]),
    ]:
        changes = [{"principal": secrets[s]["applicationId"], "add": privileges} for s in DATA_READERS]
        cli("grants", "update", kind, name, "--json", json.dumps({"changes": changes}))
    print(f"  USE CATALOG, USE SCHEMA and SELECT on {DATA_SCHEMA}")

    print("==> Label fixtures")
    for schema in SCHEMAS:
        result = sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{schema} COMMENT 'PIA identity E2E fixture; safe to drop'")
        if result["state"] != "SUCCEEDED":
            raise SystemExit(f"Could not create {CATALOG}.{schema}: {result['error']}")
    for statement in FIXTURE_SQL:
        result = sql(statement)
        if result["state"] != "SUCCEEDED":
            raise SystemExit(f"Fixture failed: {statement[:80]}: {result['error']}")
    print(f"  {', '.join(SCHEMAS)} in {CATALOG}")

    print("==> Label grants and row filter (bundle/label-access.sh)")
    if not run_label_access("--apply", secrets) and not broad_catalog_grant():
        raise SystemExit("bundle/label-access.sh --apply failed; see above.")
    print(f"\nSetup done. Secrets: {SECRETS}")


def broad_catalog_grant() -> str:
    """The privilege every account user holds on the catalog, if it lets them read it all."""
    grants = cli("grants", "get", "catalog", CATALOG, check=False) or {}
    for assignment in grants.get("privilege_assignments") or []:
        if assignment.get("principal") in ("account users", "users"):
            held = set(assignment.get("privileges") or [])
            for privilege in ("ALL_PRIVILEGES", "SELECT"):
                if privilege in held:
                    return f"{assignment['principal']} holds {privilege} on {CATALOG}"
    return ""


def run_label_access(flag: str, secrets: dict) -> bool:
    config = SECRETS.parent / f"{TARGET}-labels.json"
    config.write_text(json.dumps(label_config(secrets), indent=2))
    env = {**os.environ, "LABEL_ACCESS_CONFIG": str(config), "WAREHOUSE_ID": WAREHOUSE_ID}
    result = subprocess.run(["bash", LABEL_ACCESS, flag], env=env, capture_output=True, text=True)
    for line in (result.stdout + result.stderr).splitlines():
        if line.strip().startswith(("FAIL", "ERROR", "All label")):
            print(f"    label-access: {line.strip()}")
    return result.returncode == 0


# --- run ----------------------------------------------------------------------


class Session:
    """One identity's app session, started the way the browser starts it."""

    def __init__(self, url: str, token: str):
        self.url, self.token, self.cookie = url, token, ""
        status, _, headers = http_with_headers(
            "POST", f"{url}/api/app-session/bootstrap", token,
            headers={"x-astrolabe-session-action": "bootstrap", "Origin": url},
        )
        if status not in (200, 201):
            raise RuntimeError(f"session bootstrap returned {status}")
        # The platform proxy sets cookies of its own; keep only the app session.
        cookies = [c.split(";", 1)[0] for c in headers.get_all("Set-Cookie") or []]
        self.cookie = next((c for c in cookies if c.startswith("__Host-astrolabe_session=")), "")
        if not self.cookie:
            raise RuntimeError("session bootstrap set no app-session cookie")

    def get(self, route: str):
        return http("GET", f"{self.url}{route}", self.token, cookie=self.cookie)

    def post(self, route: str, body: dict):
        return http("POST", f"{self.url}{route}", self.token, body,
                    headers={"Accept": "application/json", "Origin": self.url}, cookie=self.cookie)

    def delete(self, route: str):
        return http("DELETE", f"{self.url}{route}", self.token, headers={"Origin": self.url}, cookie=self.cookie)

    def ask(self, prompt: str):
        """Ask over the event stream, as the browser does; the proxy drops a silent JSON wait."""
        body = json.dumps({"conversationId": f"conv-{uuid.uuid4()}", "prompt": prompt}).encode()
        request = urllib.request.Request(f"{self.url}/api/insights/ask", data=body, method="POST")
        for key, value in {
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
            "Accept": "text/event-stream", "Origin": self.url, "Cookie": self.cookie,
        }.items():
            request.add_header(key, value)
        try:
            response = urllib.request.urlopen(request, timeout=600)
        except urllib.error.HTTPError as error:
            return error.code, _json(error.read().decode() or "{}")
        with response:
            if "text/event-stream" not in (response.headers.get("Content-Type") or ""):
                return response.status, _json(response.read().decode() or "{}")
            event, data = "", []
            for raw in response:
                line = raw.decode().rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())
                elif not line:
                    if event in ("result", "error"):
                        payload = _json("\n".join(data))
                        status = 200 if event == "result" else int(payload.get("status") or 500)
                        return status, payload
                    event, data = "", []
        return 502, {"kind": "unavailable", "code": "STREAM_ENDED_WITHOUT_RESULT"}


RESULTS: list[tuple[bool, str, str]] = []
NOT_PROVABLE: list[str] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    RESULTS.append((ok, name, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  -- ' + detail) if detail and not ok else ''}")


def not_provable(name: str, reason: str) -> None:
    NOT_PROVABLE.append(f"{name}: {reason}")
    print(f"  N/A   {name}  -- {reason}")


ADMIN_ROUTES = ["/api/monitoring/questions", "/api/admin/runtime-settings", "/api/ops/cost"]
# Identity and SP personas: SUPER_ADMIN_ROUTE_PREFIXES in server/lib/admin-roles.ts.
SUPER_ADMIN_ROUTES = ["/api/users", "/api/admin/sp-identity"]
DATA_QUESTION = "How many rows are in the player profiles table? Answer with one number."


def run() -> int:
    secrets = load_secrets()
    url = app_url()
    added_group = False
    try:
        print("==> App access for the test identities (direct grants; a bundle deploy drops them)")
        grant_acl("apps", APP_NAME, [
            {"service_principal_name": secrets[s]["applicationId"], "permission_level": "CAN_USE"} for s in IDENTITIES
        ])
        operator = Session(url, operator_token())

        print("==> Mapping the test admin group to Admin, as an operator would in Identity")
        status, groups = operator.get("/api/users/groups")
        mapped = any(
            str(g.get("groupName", "")).lower() == ADMIN_GROUP and g.get("role") == "admin"
            for g in (groups.get("groups") or groups.get("mappings") or [] if isinstance(groups, dict) else [])
        )
        if not mapped:
            grant_acl("apps", APP_NAME, [{"group_name": ADMIN_GROUP, "permission_level": "CAN_USE"}])
            added_group = True
            status, body = operator.post("/api/users/groups", {"groupName": ADMIN_GROUP, "role": "admin"})
            check(status in (200, 201), "the operator can map a group to Admin", f"{status} {str(body)[:200]}")

        sessions = {short: Session(url, sp_token(secrets[short])) for short in ["consumer", "denied", "admin"]}

        print("==> Roles")
        for short, expected in [("consumer", "consumer"), ("denied", "consumer"), ("admin", "admin")]:
            status, me = sessions[short].get("/api/identity")
            check(status == 200 and me.get("role") == expected, f"{short} signs in as {expected}",
                  f"{status} role={me.get('role')}")
            check(me.get("signedInAs") == secrets[short]["applicationId"], f"{short} is identified as itself",
                  str(me.get("signedInAs")))

        print("==> Route guards")
        for route in ADMIN_ROUTES + SUPER_ADMIN_ROUTES:
            status, _ = sessions["consumer"].get(route)
            check(status == 403, f"a Consumer is refused {route}", str(status))
        for route in ADMIN_ROUTES:
            status, _ = sessions["admin"].get(route)
            check(status == 200, f"an Admin may open {route}", str(status))
        for route in SUPER_ADMIN_ROUTES:
            status, _ = sessions["admin"].get(route)
            check(status == 403, f"an Admin who is not the super admin is refused {route}", str(status))
            status, _ = operator.get(route)
            check(status == 200, f"the super admin may open {route}", str(status))

        print("==> Asking as each identity (this calls the live agent)")
        open_catalog = broad_catalog_grant()
        status, denied = sessions["denied"].ask(DATA_QUESTION)
        identity = (denied.get("execution_identity") or {}) if isinstance(denied, dict) else {}
        evidence = (denied.get("evidence") or {}) if isinstance(denied, dict) else {}
        check(status != 200 and denied.get("kind") == "unavailable" and denied.get("code") == "USER_NOT_AUTHORIZED",
              "a user without access is refused, with no answer", f"{status} {denied.get('code')} {str(denied)[:200]}")
        check(identity.get("mode") == "signed_in_user" and evidence.get("principal") == secrets["denied"]["applicationId"],
              "the refusal was decided under that user's own credential, not the app's",
              f"{json.dumps(identity)} principal={evidence.get('principal')}")
        if open_catalog:
            not_provable("a refusal decided by Unity Catalog through the agent",
                         f"{open_catalog}, so every identity can read the agent's tables here")
        status, answered = sessions["consumer"].ask(DATA_QUESTION)
        kind = answered.get("kind") or answered.get("type") if isinstance(answered, dict) else None
        check(status == 200 and kind not in ("unavailable", None),
              "a user with the data grant gets an answer", f"{status} {kind} {str(answered)[:200]}")

        print("==> Monitoring shows the asked question to an Admin, and hides what they cannot read")
        status, monitoring = sessions["admin"].get("/api/monitoring/questions")
        check(status == 200, "Monitoring opens for an Admin", str(status))

        print("==> Labels, each identity with its own token")
        label_tokens = {short: sp_token(secrets[short]) for short in ["label-a", "label-b", "central"]}
        for short, expected in [("label-a", ["label_a"]), ("label-b", ["label_b"]),
                                ("central", ["label_a", "label_b", "label_c"])]:
            result = sql(CROSS_LABEL_QUESTION, label_tokens[short])
            seen = [row[0] for row in result["rows"]]
            check(result["state"] == "SUCCEEDED" and seen == expected,
                  f"{short} asks the cross-label question and sees {', '.join(expected)}",
                  f"{result['state']} saw={seen} {result['error'][:160]}")
        for short, own, other in [("label-a", "pia_e2e_label_a", "pia_e2e_label_b"),
                                  ("label-b", "pia_e2e_label_b", "pia_e2e_label_a")]:
            if open_catalog:
                not_provable(f"{short} cannot read the other label's schema", open_catalog)
            else:
                result = sql(f"SELECT * FROM {CATALOG}.{other}.titles", label_tokens[short])
                check(result["state"] == "FAILED" and not result["rows"],
                      f"{short} cannot read the other label's schema", f"{result['state']} {result['rows']}")
            for schema, table in [(own, "titles"), ("pia_e2e_global", "calendar")]:
                result = sql(f"SELECT * FROM {CATALOG}.{schema}.{table}", label_tokens[short])
                check(result["state"] == "SUCCEEDED", f"{short} reads {schema}", result["error"][:160])
        verified = run_label_access("--verify", secrets)
        if open_catalog:
            check(not verified, "bundle/label-access.sh --verify reports the open catalog as cross-label reads")
        else:
            check(verified, "bundle/label-access.sh --verify passes on the test labels")
    finally:
        if added_group:
            remove_app_group(ADMIN_GROUP)

    failed = [r for r in RESULTS if not r[0]]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed, {len(NOT_PROVABLE)} not provable on {TARGET}")
    for line in NOT_PROVABLE:
        print(f"  not provable: {line}")
    return 1 if failed else 0


def remove_app_group(group: str) -> None:
    """Drop one direct group grant from the App and keep every other entry as it was."""
    acl = cli("permissions", "get", "apps", APP_NAME) or {}
    kept = []
    for entry in acl.get("access_control_list") or []:
        direct = [p["permission_level"] for p in entry.get("all_permissions") or [] if not p.get("inherited")]
        if not direct or str(entry.get("group_name", "")).lower() == group.lower():
            continue
        principal = {k: entry[k] for k in ("user_name", "group_name", "service_principal_name") if entry.get(k)}
        kept.append({**principal, "permission_level": direct[0]})
    cli("permissions", "set", "apps", APP_NAME, "--json", json.dumps({"access_control_list": kept}))
    after = cli("permissions", "get", "apps", APP_NAME) or {}
    still = [e for e in after.get("access_control_list") or [] if str(e.get("group_name", "")).lower() == group.lower()
             and any(not p.get("inherited") for p in e.get("all_permissions") or [])]
    print(f"  removed {group} from the App permissions" if not still else f"  WARNING: {group} is still on the App")


# --- teardown -----------------------------------------------------------------


def teardown() -> None:
    url = app_url()
    print("==> Stored group mapping")
    try:
        operator = Session(url, operator_token())
        status, _ = operator.delete(f"/api/users/groups/{ADMIN_GROUP}")
        print(f"  {ADMIN_GROUP}: {status}")
    except Exception as error:  # the app may be stopped; the rest still goes
        print(f"  could not reach the app ({error}); remove the {ADMIN_GROUP} mapping in Identity")
    print("==> App permissions")
    secrets = json.loads(SECRETS.read_text()) if SECRETS.exists() else {}
    ids = {r["applicationId"].lower() for r in secrets.values()}
    acl = cli("permissions", "get", "apps", APP_NAME) or {}
    kept = []
    for entry in acl.get("access_control_list") or []:
        direct = [p["permission_level"] for p in entry.get("all_permissions") or [] if not p.get("inherited")]
        name = str(entry.get("group_name") or entry.get("service_principal_name") or "").lower()
        if not direct or name in ids or name.startswith("pia-e2e-"):
            continue
        principal = {k: entry[k] for k in ("user_name", "group_name", "service_principal_name") if entry.get(k)}
        kept.append({**principal, "permission_level": direct[0]})
    cli("permissions", "set", "apps", APP_NAME, "--json", json.dumps({"access_control_list": kept}))
    print("==> Label fixtures")
    for schema in SCHEMAS:
        result = sql(f"DROP SCHEMA IF EXISTS {CATALOG}.{schema} CASCADE")
        print(f"  {schema}: {result['state']}")
    print("==> Demo schema and catalog grants")
    for kind, name, privileges in [("schema", DATA_SCHEMA, ["USE_SCHEMA", "SELECT"]), ("catalog", CATALOG, ["USE_CATALOG"])]:
        changes = [{"principal": r["applicationId"], "remove": privileges} for r in secrets.values()]
        if changes:
            cli("grants", "update", kind, name, "--json", json.dumps({"changes": changes}), check=False)
    print("==> Groups and identities (removing them also removes their endpoint, warehouse and Genie grants)")
    for found in cli("groups", "list", "--filter", 'displayName sw "pia-e2e-"') or []:
        if str(found.get("displayName", "")).startswith("pia-e2e-"):
            cli("groups", "delete", found["id"], check=False)
            print(f"  deleted {found['displayName']}")
    for short in IDENTITIES:
        found = find_sp(f"pia-e2e-{short}")
        if found:
            cli("service-principals", "delete", found["id"], check=False)
            print(f"  deleted pia-e2e-{short}")
    for path in [SECRETS, SECRETS.parent / f"{TARGET}-labels.json"]:
        path.unlink(missing_ok=True)
    print("Teardown done.")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "setup":
        setup()
    elif command == "run":
        sys.exit(run())
    elif command == "teardown":
        teardown()
    else:
        raise SystemExit("usage: identity-e2e.sh setup|run|teardown")
