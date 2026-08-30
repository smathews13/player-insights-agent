#!/usr/bin/env node
// Produces build/deploy/: a dependency-free source tree for `databricks apps deploy`.
// The Databricks Apps build step only runs `npm install` when the uploaded source
// contains a package.json, so the deploy tree deliberately has none.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDeployAppYaml } from './deploy-app-yaml.mjs';
import { copyAccessGuideAsset } from './access-guide-asset.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'deploy');

// The per-file ceiling `databricks apps deploy` enforces (troubleshooting fact 3).
export const MAX_DEPLOY_FILE_BYTES = 10 * 1024 * 1024;

// Dev-only module graphs reached through dynamic import()/try-catch requires.
// They never execute under NODE_ENV=production but esbuild would still try to
// pull their native bindings into the bundle.
const external = [
  'vite',
  'rolldown-vite',
  '@vitejs/plugin-react',
  '@tailwindcss/vite',
  'esbuild',
  'rolldown',
  'pg-native',
  'fsevents',
  'lightningcss',
];

// @databricks/appkit's runtime entrypoint statically imports the native
// @ast-grep/napi parser for its build-time serving type generator. A static
// ESM import cannot stay external in a dependency-free deploy tree, so it is
// aliased to a stub that only fails if the codegen path is ever reached.
const astGrepStub = path.join(root, 'build', 'stubs', 'ast-grep-napi.mjs');
const astGrepStubSource = `const unavailable = () => {
  throw new Error('@ast-grep/napi is not bundled into the deployed server; it is only used by AppKit build-time codegen.'
  );
};
export const Lang = new Proxy({}, { get: () => 'TypeScript' });
export const parse = unavailable;
export default { Lang, parse };
`;

// CJS globals are shimmed under distinct names because some bundled modules
// declare their own module-scoped `__filename` / `__dirname`, which would
// collide with top-level banner declarations.
const banner = `import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __pathDirname } from 'node:path';
const require = __createRequire(import.meta.url);
const __appkitFilename = __fileURLToPath(import.meta.url);
const __appkitDirname = __pathDirname(__appkitFilename);
`;

// Databricks Apps refuses to export any single source file larger than 10 MB
// during deployment. The heaviest packages are emitted as sibling vendor
// modules so no single file approaches that ceiling, which also leaves room
// for the server bundle to grow.
const vendorPackages = ['unpdf', '@databricks/sdk-experimental'];

// Appended when the tree this build came from held uncommitted tracked changes.
// The same suffix and the same rule as agent/preflight.py's DIRTY_SUFFIX: the two
// stamps are compared against each other, so a difference in how they are formed
// would read as skew that is not there. Untracked files are ignored, because a
// local mlflow.db and mlruns/ appear in every tree either side has ever built in.
const DIRTY_SUFFIX = '+dirty';

/**
 * The commit this build came from, or '' when it cannot be known.
 *
 * PLAYER_INSIGHTS_SOURCE_SHA, when set, wins over git and is recorded verbatim.
 * It names a source COMMIT, so it never gains the +dirty suffix. This supports
 * release builds staged outside a Git checkout. PLAYER_INSIGHTS_BUILD_SHA stays
 * the git-absent fallback for a bare local build.
 */
function resolveBuildStamp(env = process.env) {
  const explicit = (env.PLAYER_INSIGHTS_SOURCE_SHA ?? '').trim();
  if (explicit) return explicit;

  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  };
  const head = git(['rev-parse', 'HEAD']);
  if (head) {
    const dirt = git(['status', '--porcelain', '--untracked-files=no']);
    return dirt ? `${head}${DIRTY_SUFFIX}` : head;
  }
  return (env.PLAYER_INSIGHTS_BUILD_SHA ?? '').trim();
}

/**
 * Commits reachable from the app stamp while the source checkout still exists.
 *
 * The deployed container has no git history, so runtime code cannot safely infer
 * whether a different model stamp is merely older or genuinely divergent.
 * Publication builds may provide the list explicitly when their staged tree has
 * no .git; otherwise derive it from the exact source commit being stamped.
 */
function resolveBuildAncestors(buildSha, env = process.env) {
  const explicit = (env.PLAYER_INSIGHTS_BUILD_ANCESTORS ?? '').trim();
  if (explicit) return explicit;
  const commit = buildSha.replace(/\+dirty$/, '').trim();
  if (!commit) return '';
  try {
    return execFileSync('git', ['rev-list', commit], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(',');
  } catch {
    return '';
  }
}

function vendorFileName(pkg) {
  return `vendor-${pkg.replace(/^@/, '').replace(/\//g, '-')}.mjs`;
}

function vendorExternalsPlugin() {
  const pattern = new RegExp(`^(${vendorPackages.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
  return {
    name: 'vendor-externals',
    setup(builder) {
      builder.onResolve({ filter: pattern }, (args) => ({
        path: `./${vendorFileName(args.path)}`,
        external: true,
      }));
    },
  };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  'default',
  'delete',
  'class',
  'function',
  'return',
  'import',
  'export',
  'const',
  'let',
  'var',
  'new',
  'typeof',
  'void',
  'null',
  'true',
  'false',
  'this',
  'super',
  'switch',
  'case',
  'catch',
]);

// `export * from` cannot re-export a CommonJS package, because the names are
// not statically analysable. Resolving the package here and emitting explicit
// bindings works for both CJS and ESM vendors.
async function vendorEntrySource(pkg) {
  const namespace = await import(pkg);
  const source = namespace.default && typeof namespace.default === 'object' ? namespace.default : namespace;
  const names = Object.keys(source).filter((n) => IDENTIFIER.test(n) && !RESERVED.has(n));
  return `import * as namespace from '${pkg}';
const source = namespace.default && typeof namespace.default === 'object' ? namespace.default : namespace;
export const { ${names.join(', ')} } = source;
export default source;
`;
}

async function bundleVendors() {
  const entryDir = path.join(root, 'build', 'vendor-entries');
  await mkdir(entryDir, { recursive: true });
  for (const pkg of vendorPackages) {
    const entry = path.join(entryDir, vendorFileName(pkg));
    await writeFile(entry, await vendorEntrySource(pkg));
    await build({
      entryPoints: [entry],
      outfile: path.join(outDir, vendorFileName(pkg)),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external,
      alias: { '@ast-grep/napi': astGrepStub },
      banner: { js: banner },
      define: {
        'process.env.NODE_ENV': '"production"',
        __filename: '__appkitFilename',
        __dirname: '__appkitDirname',
      },
      logLevel: 'warning',
      // ESM-only packages have no default export; the `?? namespace` fallback
      // in the generated entry is exactly the intended behaviour.
      logOverride: { 'import-is-undefined': 'silent' },
    });
  }
}

async function bundleServer() {
  await build({
    entryPoints: [path.join(root, 'server', 'server.ts')],
    outfile: path.join(outDir, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external,
    alias: { '@ast-grep/napi': astGrepStub },
    plugins: [vendorExternalsPlugin()],
    banner: { js: banner },
    logLevel: 'info',
    logOverride: { 'require-resolve-not-external': 'silent' },
    // Minifying breaks the Databricks SDK request path behind the serving
    // transport, which silently downgrades /api/insights/ask to representative
    // answers instead of failing loudly. Vendor splitting above, not
    // minification, is what keeps files under the per-file size limit.
    minify: false,
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      __filename: '__appkitFilename',
      __dirname: '__appkitDirname',
    },
  });
}

async function main() {
  if (!existsSync(path.join(root, 'client', 'dist', 'index.html'))) {
    throw new Error('client/dist/index.html missing, run `npm run build:client` first.');
  }
  if (!existsSync(path.join(root, 'app.yaml'))) {
    throw new Error('app.yaml missing: the deployed app.yaml is derived from it, not written from scratch.');
  }

  // Resolved BEFORE the lines below destroy and rewrite build/deploy, and that
  // ordering is the whole point. build/deploy is tracked on purpose, because the
  // browser "From Git" app deploy reads it, so a stamp measured after the write
  // reads this build's own output as source dirt and returns +dirty from a
  // pristine checkout. It does not converge either: committing that bundle only
  // yields a commit whose app.yaml differs again. Measured here, the stamp
  // describes the source tree as it stood when the build started, so a build from
  // a clean checkout names a commit that rebuilds the artifact, while a previous
  // build's still-uncommitted output is real dirt and is still reported.
  const buildSha = resolveBuildStamp();
  const buildAncestors = resolveBuildAncestors(buildSha);
  if (!buildSha) {
    throw new Error(
      'No app build stamp could be resolved. Build from a Git checkout or set ' +
        'PLAYER_INSIGHTS_SOURCE_SHA to the source commit before creating the deploy artifact.'
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(astGrepStub), { recursive: true });
  await writeFile(astGrepStub, astGrepStubSource);

  await bundleVendors();
  await bundleServer();

  // AppKit's ServerPlugin.findStaticPath() probes cwd for dist|client/dist|build|public|out.
  //
  // client/public used to hold an app.yaml and a standalone server.mjs left over from an
  // earlier static demo. Vite copies public/ verbatim, so client/dist ended up looking
  // like a deployable Databricks App root that would run a 107-line fake server, and
  // this filter was the only thing standing between it and a deploy. Both files are now
  // deleted at source. The filter stays as a guard: a file named like a platform
  // entrypoint must never reach the deploy tree just because someone put it in public/.
  const skipFromStatic = new Set(['app.yaml', 'server.mjs']);
  await cp(path.join(root, 'client', 'dist'), path.join(outDir, 'client', 'dist'), {
    recursive: true,
    filter: (src) => !skipFromStatic.has(path.basename(src)),
  });
  await copyAccessGuideAsset({ root, outDir });

  // Passed through rather than interpreted. The server decides what counts as
  // "on". This only has to make sure the value the release resolved actually
  // reaches the container, which is the step that has silently dropped a
  // variable before.
  const sharedRail = (process.env.PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL ?? '').trim();
  if (sharedRail && sharedRail.toLowerCase() === 'true') {
    console.log(
      '\n  note  PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL=true: the deployed app.yaml will let every\n' +
        "        signed-in user see and open every other user's conversations. Deliberate for a shared\n" +
        '        evaluation workspace; not the default.'
    );
  }

  if (buildSha.endsWith(DIRTY_SUFFIX)) {
    console.log(
      `\n  note  building from a tree with uncommitted tracked changes (${buildSha}).\n` +
        '        The stamp records it. The release sequence asks for a clean worktree\n' +
        '        because the artifact cannot be reproduced from any commit.'
    );
  }

  // The judge model is per deployment and only exists in the bundle, so app.yaml
  // authors it empty and the release supplies it, same mechanism as the
  // experiment id. Absent here leaves the authored empty value standing, which
  // means the server falls through to its compiled default: the documented
  // degradation, and what every deployment did before the variable was declared.
  const judgeEndpoint = (process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT ?? '').trim();

  // Where app telemetry lands, as `catalog.schema`. Empty is the normal case for
  // a customer target and means telemetry is off, so absent here is a working
  // deployment rather than a broken one: the Ops tab says telemetry is not
  // configured, and the administrator settings say there is no telemetry access
  // to grant. bundle/app-release.sh builds it from the target's own variables.
  const telemetrySchema = (process.env.PLAYER_INSIGHTS_TELEMETRY_SCHEMA ?? '').trim();

  // Greenfield bootstrap only. App boot writes these roles to Lakebase when the
  // roster is empty; once any row exists, the database is authoritative and
  // this value is ignored. A stale or absent value can never change an existing
  // role.
  const adminEmails = (process.env.PLAYER_INSIGHTS_ADMIN_EMAILS ?? '').trim();
  const organizations = (process.env.PLAYER_INSIGHTS_ORGANIZATIONS ?? '').trim();
  // Empty is intentional: the server bundle contains the validated public
  // defaults. A deployment-provided array or explicit replace/extend object is
  // carried into app.yaml and interpreted fail-closed by the server.
  const personaTemplateOverride = (process.env.PLAYER_INSIGHTS_PERSONA_TEMPLATES ?? '').trim();
  // Passed through exactly. The server owns validation, clamping, and the
  // explicit `disabled` value; this build step only carries the target policy
  // into the dependency-free app artifact.
  const idleTimeout = (process.env.PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES ?? '').trim();
  if (!adminEmails) {
    console.log(
      '\n  note  PLAYER_INSIGHTS_ADMIN_EMAILS not set: a genuinely empty Lakebase roster\n' +
        '        will bootstrap nobody, so every administrative surface will refuse callers.\n' +
        '        An existing roster is unchanged because deployment config is ignored after\n' +
        '        bootstrap. To seed a greenfield deployment, set admin_emails in\n' +
        '        .databricks/bundle/<target>/variable-overrides.json, which is git-ignored,\n' +
        '        or PLAYER_INSIGHTS_ADMIN_EMAILS in the environment you release from.'
    );
  } else {
    // The one value this script writes that is a person rather than a resource.
    // build/deploy/ is committed so the app can be deployed from Git, and it
    // publishes, so a routine `git add` after a release is the whole leak. The
    // release does not need the commit: it uploads this tree with
    // `workspace import-dir`, straight from the local build.
    console.log(
      '\n  note  the generated build/deploy/app.yaml now carries administrator addresses.\n' +
        '        DO NOT COMMIT IT. That file is tracked and is published to customers, and\n' +
        '        an address is a personal name and an employer. The release uploads the\n' +
        '        local tree directly, so the container gets the list either way. Restore it\n' +
        '        afterwards with:  git restore -- ':(glob)*/build/deploy/app.yaml''
    );
  }

  // The user API scopes the released target declares. Passed through rather than
  // interpreted, like the shared-rail flag above: the app decides what to do with
  // them. A bundle release replaces the authored value with the target's exact
  // App-resource declaration. A bare `npm run build:deploy` has no target to read,
  // so it preserves app.yaml's four ask-path scopes: the safe Git-deploy contract.
  const declaredScopes = (process.env.PLAYER_INSIGHTS_USER_API_SCOPES ?? '').trim();
  // The target is execution metadata, not a user-editable app setting. Empty in
  // source and filled only by bundle/app-release.sh for the generated deploy
  // tree, so a release request can hand the helper the exact approved target.
  const bundleTarget = (process.env.PLAYER_INSIGHTS_TARGET ?? '').trim();

  // Postgres schema the app owns. Authored as player_insights in app.yaml; the
  // release overrides from var.lakebase_app_schema so Connections and DDL agree
  // with the bundle. Absent here leaves the authored default standing.
  const appSchema = (process.env.PLAYER_INSIGHTS_APP_SCHEMA ?? '').trim();
  const indexRebuildJobId = (process.env.PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID ?? '').trim();
  const catalog = (process.env.PLAYER_INSIGHTS_CATALOG ?? '').trim();
  const schema = (process.env.PLAYER_INSIGHTS_SCHEMA ?? '').trim();
  const dataGenieId = (process.env.PLAYER_INSIGHTS_DATA_GENIE_ID ?? '').trim();
  const dictionaryGenieId = (process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_ID ?? '').trim();
  const llmEndpoint = (process.env.PLAYER_INSIGHTS_LLM_ENDPOINT ?? '').trim();

  const experimentId = (process.env.PLAYER_INSIGHTS_EXPERIMENT_ID ?? '').trim();
  if (!experimentId) {
    console.log(
      '\n  note  PLAYER_INSIGHTS_EXPERIMENT_ID not set: the deployed app.yaml will carry an\n' +
        '        empty value and Run Explorer will show trace ids without a deep link.\n' +
        '        bundle/app-release.sh sets it from the bundle; a bare `npm run build:deploy`\n' +
        '        has no target to read it from.'
    );
  }

  // Derived from the authored app.yaml, never rewritten from scratch: a literal
  // here is a second source of truth, and it already swallowed one variable
  // silently. Only the genuine deploy-target differences are stated.
  await writeDeployAppYaml({
    from: path.join(root, 'app.yaml'),
    to: path.join(outDir, 'app.yaml'),
    banner: '# Generated by scripts/bundle-server.mjs from app.yaml. Edit that file, not this one.',
    // No package.json in the deploy tree, so there is no `npm run start` to call...
    command: "['node', 'server.mjs']",
    env: [
      // ...and losing it also loses the NODE_ENV that script was setting.
      { name: 'NODE_ENV', value: 'production' },
      ...(bundleTarget ? [{ name: 'PLAYER_INSIGHTS_TARGET', value: `'${bundleTarget}'` }] : []),
      ...(indexRebuildJobId ? [{ name: 'PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID', value: `'${indexRebuildJobId}'` }] : []),
      // The MLflow experiment is per-workspace, so app.yaml declares the variable
      // without a value and the release supplies it. bundle/app-release.sh reads
      // it out of the bundle target being deployed. Absent here means the authored
      // empty value stands and Run Explorer simply omits the deep link, which is
      // the documented degradation, far better than shipping our experiment id.
      ...(experimentId ? [{ name: 'PLAYER_INSIGHTS_EXPERIMENT_ID', value: `'${experimentId}'` }] : []),
      // Resolved from git here rather than passed in by the release, because this
      // is the step that turns source into the artifact being stamped. Nothing
      // else knows what went into it.
      ...(buildSha ? [{ name: 'PLAYER_INSIGHTS_BUILD_SHA', value: `'${buildSha}'` }] : []),
      ...(buildAncestors ? [{ name: 'PLAYER_INSIGHTS_BUILD_ANCESTORS', value: `'${buildAncestors}'` }] : []),
      ...(appSchema ? [{ name: 'PLAYER_INSIGHTS_APP_SCHEMA', value: `'${appSchema}'` }] : []),
      ...(idleTimeout ? [{ name: 'PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES', value: `'${idleTimeout}'` }] : []),
      ...(catalog ? [{ name: 'PLAYER_INSIGHTS_CATALOG', value: `'${catalog}'` }] : []),
      ...(schema ? [{ name: 'PLAYER_INSIGHTS_SCHEMA', value: `'${schema}'` }] : []),
      ...(dataGenieId ? [{ name: 'PLAYER_INSIGHTS_DATA_GENIE_ID', value: `'${dataGenieId}'` }] : []),
      ...(dictionaryGenieId ? [{ name: 'PLAYER_INSIGHTS_DICTIONARY_GENIE_ID', value: `'${dictionaryGenieId}'` }] : []),
      ...(llmEndpoint ? [{ name: 'PLAYER_INSIGHTS_LLM_ENDPOINT', value: `'${llmEndpoint}'` }] : []),
      ...(judgeEndpoint ? [{ name: 'PLAYER_INSIGHTS_JUDGE_ENDPOINT', value: `'${judgeEndpoint}'` }] : []),
      // Whether the rail is shared is per-deployment, so app.yaml authors the
      // safe default and the release states the target's answer. Absent here
      // leaves the authored 'false' standing, which is the correct degradation:
      // a release that could not resolve the variable must not be the thing
      // that opens one stakeholder's conversations to another.
      ...(sharedRail ? [{ name: 'PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL', value: `'${sharedRail}'` }] : []),
      // Both per-deployment and correctly empty when unresolved. No telemetry
      // destination means telemetry is off. No admin bootstrap means only that a
      // genuinely empty roster gets no first row; an existing Lakebase roster is
      // untouched. Neither default ships one workspace's values into another.
      ...(telemetrySchema ? [{ name: 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA', value: `'${telemetrySchema}'` }] : []),
      // Per-target when resolved. Otherwise keep the authored four-scope
      // Git-deploy contract; renderDeployAppYaml replaces this entry only when a
      // release supplies the App resource's exact declaration.
      ...(declaredScopes ? [{ name: 'PLAYER_INSIGHTS_USER_API_SCOPES', value: `'${declaredScopes}'` }] : []),
      ...(adminEmails ? [{ name: 'PLAYER_INSIGHTS_ADMIN_EMAILS', value: `'${adminEmails}'` }] : []),
      ...(organizations
        ? [{ name: 'PLAYER_INSIGHTS_ORGANIZATIONS', value: `'${organizations.replaceAll("'", "''")}'` }]
        : []),
      ...(personaTemplateOverride
        ? [{ name: 'PLAYER_INSIGHTS_PERSONA_TEMPLATES', value: `'${personaTemplateOverride.replaceAll("'", "''")}'` }]
        : []),
    ],
  });

  // Every file in the tree, not just the ones this script bundles. The platform applies
  // its per-file ceiling to whatever is uploaded, and client/dist is uploaded too: a
  // lazily-loaded chart library or a large font would be caught by the platform and not
  // by a check that only looked at server.mjs.
  async function treeFiles(dir, prefix = '') {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) found.push(...(await treeFiles(path.join(dir, entry.name), relative)));
      else found.push({ name: relative, size: (await stat(path.join(dir, entry.name))).size });
    }
    return found;
  }

  const files = (await treeFiles(outDir)).sort((a, b) => b.size - a.size);
  const oversized = files.filter((file) => file.size > MAX_DEPLOY_FILE_BYTES);
  console.log('');
  // Only the ones worth reading. A tree listing every icon buries the number that matters.
  for (const file of files.filter((f) => f.size > 64 * 1024 || oversized.includes(f))) {
    console.log(
      `  ${file.name.padEnd(46)} ${(file.size / 1024 / 1024).toFixed(2).padStart(6)} MB` +
        (file.size > MAX_DEPLOY_FILE_BYTES ? '   EXCEEDS 10 MB DEPLOY LIMIT' : '')
    );
  }
  console.log(
    `  ${String(`(${files.length} files total)`).padEnd(46)} ` +
      `${(files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2).padStart(6)} MB`
  );
  if (oversized.length > 0) {
    throw new Error(
      `${oversized.map((f) => f.name).join(', ')} exceeds the 10 MB Databricks Apps limit. ` +
        'For a server file, add the heaviest package to vendorPackages in this script; for a ' +
        'client asset, split it with a dynamic import().'
    );
  }
  console.log('\nbuild/deploy ready: no package.json, so the platform skips npm install entirely.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
