
import "./chunk-LLUDDZ3A.mjs";

// server/lib/environment-info.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var MASK = "***";
var SECRET_KEY = /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|BEARER|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;
function isSensitiveEnvironmentKey(key) {
  return SECRET_KEY.test(key);
}
function looksLikeSecretValue(value) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/^dapi[a-f0-9]{20,}$/i.test(value)) return true;
  if (/^Bearer\s+\S+$/i.test(value)) return true;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}
function maskedEnvironment(environment = process.env) {
  return Object.entries(environment).filter((entry) => typeof entry[1] === "string").map(([key, value]) => ({
    key,
    value: isSensitiveEnvironmentKey(key) || looksLikeSecretValue(value) ? MASK : value
  })).sort((left, right) => left.key.localeCompare(right.key));
}
function parsePipPackages(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("pip returned an invalid package list");
  return parsed.filter(
    (entry) => typeof entry === "object" && entry !== null && typeof entry.name === "string" && typeof entry.version === "string"
  ).map(({ name, version }) => ({ name, version })).sort((left, right) => left.name.localeCompare(right.name));
}
async function run(command, arguments_, includeStderr) {
  const { stdout, stderr } = await execFileAsync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5e3
  });
  return (includeStderr ? `${stdout}${stderr}` : stdout).trim();
}
async function firstPython(arguments_, includeStderr = false) {
  for (const command of ["python3", "python"]) {
    try {
      return await run(command, arguments_, includeStderr);
    } catch {
    }
  }
  return "";
}
async function readEnvironmentInfo(environment = process.env) {
  const [pythonVersion, packagesJson] = await Promise.all([
    firstPython(["--version"], true),
    firstPython(["-m", "pip", "list", "--format=json", "--disable-pip-version-check"])
  ]);
  let packages = [];
  if (packagesJson) {
    try {
      packages = parsePipPackages(packagesJson);
    } catch (error) {
      console.warn("[environment] pip package list could not be parsed:", error.message);
    }
  }
  return {
    runtime: {
      python: pythonVersion.replace(/^Python\s+/i, ""),
      node: process.version
    },
    variables: maskedEnvironment(environment),
    packages
  };
}

// server/routes/environment-routes.ts
function setupEnvironmentRoutes(appkit) {
  appkit.server.extend((app) => {
    app.get("/api/environment", async (_req, res) => {
      try {
        res.json(await readEnvironmentInfo());
      } catch (error) {
        console.error("[environment] Runtime details could not be read:", error.message);
        res.status(503).json({
          error: "environment_unavailable",
          detail: "Runtime details are not available just now."
        });
      }
    });
  });
}
export {
  setupEnvironmentRoutes
};
