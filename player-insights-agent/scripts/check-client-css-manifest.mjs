import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'client', 'dist');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite', 'manifest.json'), 'utf8'));

const routes = {
  ArchitecturePage: '.architecture-page{',
  BenchmarkLab: '.benchmark-lab{',
  ConnectionsPage: '.connections-page{',
  MonitoringPage: '.monitoring-page{',
  OpsPage: '.ops-page{',
  RunExplorer: '.run-explorer{',
  SettingsPage: '.settings-page{',
};

const entry = manifest['index.html'];
if (!entry?.isEntry || entry.css?.length !== 1) {
  throw new Error('The client entry must declare exactly one initial stylesheet');
}

const cssAssets = new Map();
for (const item of Object.values(manifest)) {
  for (const asset of item.css ?? []) {
    if (!cssAssets.has(asset)) cssAssets.set(asset, readFileSync(path.join(dist, asset), 'utf8'));
  }
}

const entryAsset = entry.css[0];
const entryCss = cssAssets.get(entryAsset);
if (!entryCss) throw new Error(`Entry stylesheet ${entryAsset} is missing`);

for (const [route, sentinel] of Object.entries(routes)) {
  const record = manifest[`src/${route}.tsx`];
  if (!record?.isDynamicEntry || record.css?.length !== 1) {
    throw new Error(`${route} must be a dynamic entry with one owned CSS chunk`);
  }
  const owners = [...cssAssets].filter(([, css]) => css.includes(sentinel)).map(([asset]) => asset);
  if (owners.length !== 1 || owners[0] !== record.css[0]) {
    throw new Error(`${route}'s selector must exist only in its own CSS chunk; found ${owners.join(', ') || 'none'}`);
  }
  if (entryCss.includes(sentinel)) throw new Error(`${route}'s CSS leaked into the Ask entry stylesheet`);
}

const timeRange = Object.values(manifest).find((item) => item.name === 'TimeRangeControl');
if (!timeRange?.css?.length) throw new Error('The shared TimeRangeControl CSS chunk is missing');

const bytes = (asset) => {
  const raw = Buffer.from(cssAssets.get(asset));
  return { raw: raw.length, gzip: gzipSync(raw).length };
};
const initial = bytes(entryAsset);
const routeMeasurements = Object.fromEntries(
  Object.keys(routes).map((route) => {
    const asset = manifest[`src/${route}.tsx`].css[0];
    return [route, { asset, ...bytes(asset) }];
  })
);

console.log(
  JSON.stringify(
    {
      initial: { asset: entryAsset, ...initial },
      shared: { TimeRangeControl: { asset: timeRange.css[0], ...bytes(timeRange.css[0]) } },
      routes: routeMeasurements,
    },
    null,
    2
  )
);
