#!/usr/bin/env node
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DEPLOY_DIR = path.join(ROOT, 'build', 'deploy');
const DEFAULT_LIMITS_PATH = path.join(ROOT, 'scripts', 'bundle-budget-limits.json');
const ZOD_MARKERS = ['$ZodType', 'Invalid option: expected one of'];

function bytes(file) {
  return readFileSync(file).byteLength;
}

function compressedBytes(file) {
  return gzipSync(readFileSync(file), { level: 9 }).byteLength;
}

function relativeAsset(htmlFile, href) {
  return path.resolve(path.dirname(htmlFile), href.replace(/^\//, ''));
}

function htmlAssets(htmlFile, relationship) {
  const html = readFileSync(htmlFile, 'utf8');
  const matches =
    relationship === 'entry'
      ? html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/g)
      : relationship === 'preload'
        ? html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g)
        : html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g);
  return [...matches].map((match) => relativeAsset(htmlFile, match[1]));
}

function staticImports(file) {
  const source = readFileSync(file, 'utf8');
  const imports = source.matchAll(/\bimport(?:[^('"`;]*?\bfrom)?\s*["']([^"']+)["']/g);
  return [...imports]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
}

function eagerGraph(entries) {
  const pending = [...entries];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (!existsSync(file)) throw new Error(`Bundle graph references missing file: ${file}`);
    visited.add(file);
    pending.push(...staticImports(file));
  }
  return [...visited].sort();
}

function treeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? treeFiles(file) : [file];
  });
}

function totals(files) {
  return {
    raw: files.reduce((sum, file) => sum + bytes(file), 0),
    compressed: files.reduce((sum, file) => sum + compressedBytes(file), 0),
  };
}

function metric(raw, compressed) {
  return { raw, compressed };
}

export function inspectBundle(deployDir = DEFAULT_DEPLOY_DIR) {
  const htmlFile = path.join(deployDir, 'client', 'dist', 'index.html');
  const browserEntry = htmlAssets(htmlFile, 'entry');
  if (browserEntry.length !== 1) {
    throw new Error(`Expected one production browser entry in ${htmlFile}; found ${browserEntry.length}.`);
  }
  const preloads = htmlAssets(htmlFile, 'preload');
  const initialJsFiles = eagerGraph([...browserEntry, ...preloads]);
  const initialCssFiles = htmlAssets(htmlFile, 'stylesheet');
  const appkitFiles = initialJsFiles.filter((file) => path.basename(file).startsWith('appkit-ui-'));
  const browserJsFiles = treeFiles(path.dirname(htmlFile)).filter((file) => file.endsWith('.js'));
  const zodChunks = browserJsFiles.filter((file) => path.basename(file).startsWith('zod-'));
  if (appkitFiles.length !== 1) {
    throw new Error(`Expected one tracked AppKit chunk in the initial graph; found ${appkitFiles.length}.`);
  }
  if (zodChunks.length !== 1) {
    throw new Error(`Expected one lazy authoritative Zod chunk; found ${zodChunks.length}.`);
  }

  const zodInInitial = initialJsFiles.filter((file) => {
    const source = readFileSync(file, 'utf8');
    return path.basename(file).startsWith('zod-') || ZOD_MARKERS.some((marker) => source.includes(marker));
  });
  if (zodInInitial.length > 0) {
    throw new Error(
      `Zod entered the initial Ask graph through: ${zodInInitial.map((file) => path.relative(deployDir, file)).join(', ')}`
    );
  }

  const serverEntry = path.join(deployDir, 'server.mjs');
  const serverFiles = eagerGraph([serverEntry]);
  const deployFiles = treeFiles(deployDir);
  const largest = deployFiles
    .map((file) => ({ file: path.relative(deployDir, file), raw: bytes(file) }))
    .sort((left, right) => right.raw - left.raw || left.file.localeCompare(right.file))[0];
  const initialJs = totals(initialJsFiles);
  const initialCss = totals(initialCssFiles);
  const home = totals(browserEntry);
  const appkit = totals(appkitFiles);
  const server = totals(serverFiles);
  const deploy = totals(deployFiles);

  return {
    metrics: {
      initialJs: metric(initialJs.raw, initialJs.compressed),
      initialCss: metric(initialCss.raw, initialCss.compressed),
      homeEntry: metric(home.raw, home.compressed),
      appkitJs: metric(appkit.raw, appkit.compressed),
      eagerServerGraph: metric(server.raw, server.compressed),
      largestDeployFile: metric(largest.raw, compressedBytes(path.join(deployDir, largest.file))),
      totalDeployArtifact: metric(deploy.raw, deploy.compressed),
    },
    files: {
      initialJs: initialJsFiles.map((file) => path.relative(deployDir, file)),
      initialCss: initialCssFiles.map((file) => path.relative(deployDir, file)),
      homeEntry: browserEntry.map((file) => path.relative(deployDir, file)),
      appkitJs: appkitFiles.map((file) => path.relative(deployDir, file)),
      lazyValidator: zodChunks.map((file) => path.relative(deployDir, file)),
      eagerServerGraph: serverFiles.map((file) => path.relative(deployDir, file)),
      largestDeployFile: [largest.file],
    },
  };
}

export function budgetFindings(report, limits) {
  const findings = [];
  for (const [name, values] of Object.entries(report.metrics)) {
    const limit = limits[name];
    if (!limit) {
      findings.push(`${name}: no budget is recorded`);
      continue;
    }
    for (const [measurement, actual] of Object.entries(values)) {
      const ceiling = limit[measurement];
      if (!Number.isInteger(ceiling) || ceiling <= 0) {
        findings.push(`${name}.${measurement}: no positive integer budget is recorded`);
      } else if (actual > ceiling) {
        findings.push(`${name}.${measurement}: ${actual} bytes exceeds ${ceiling} byte budget`);
      }
    }
  }
  return findings;
}

function kb(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

export function formatReport(report, limits) {
  const lines = ['Production bundle budgets (raw and deterministic gzip level 9)'];
  for (const [name, values] of Object.entries(report.metrics)) {
    const limit = limits[name];
    const measured = Object.entries(values)
      .map(([kind, value]) => `${kind} ${kb(value)} / ${kb(limit?.[kind] ?? 0)}`)
      .join(', ');
    const tracked = name === 'appkitJs' ? ' (tracked external weight)' : '';
    lines.push(`  ${name}${tracked}: ${measured}`);
  }
  lines.push(`  lazy validator: ${report.files.lazyValidator.join(', ')} (not initial)`);
  lines.push(`  largest: ${report.files.largestDeployFile[0]}`);
  return lines.join('\n');
}

function main() {
  const json = process.argv.includes('--json');
  const deployDir = process.env.PLAYER_INSIGHTS_BUDGET_DEPLOY_DIR || DEFAULT_DEPLOY_DIR;
  const limitsPath = process.env.PLAYER_INSIGHTS_BUDGET_LIMITS || DEFAULT_LIMITS_PATH;
  if (!existsSync(path.join(deployDir, 'server.mjs'))) {
    throw new Error(`Production deploy artifact missing at ${deployDir}; run npm run build:deploy first.`);
  }
  const limits = JSON.parse(readFileSync(limitsPath, 'utf8'));
  const report = inspectBundle(deployDir);
  const findings = budgetFindings(report, limits);
  console.log(json ? JSON.stringify({ ...report, limits, findings }, null, 2) : formatReport(report, limits));
  if (findings.length > 0) throw new Error(`Bundle budget failed:\n- ${findings.join('\n- ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
