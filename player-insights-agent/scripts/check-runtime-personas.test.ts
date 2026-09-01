import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- a build script, deliberately outside the tsconfig projects.
import { validateRuntimePersonas } from './check-runtime-personas.mjs';

const PERSONAS = `
const templates = [
  {
    id: "business-analyst",
    displayName: "Business Analyst",
    roleSummary: "Read-only analyst for governed performance and player investigation."
  },
  {
    id: "marketing-scientist",
    displayName: "Marketing Scientist",
    roleSummary: "Read-only marketing scientist for governed audience, purchase, and player-profile analysis."
  }
];
`;

const fixtures: string[] = [];

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runtime-personas-'));
  fixtures.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('reachable deploy runtime personas', () => {
  it('follows split static and dynamic imports but ignores orphan chunks', () => {
    const directory = fixture();
    writeFileSync(path.join(directory, 'server.mjs'), 'import "./chunk.mjs";\nimport("./persona-route.mjs");\n');
    writeFileSync(path.join(directory, 'chunk.mjs'), 'export const shared = true;\n');
    writeFileSync(path.join(directory, 'persona-route.mjs'), PERSONAS);
    writeFileSync(path.join(directory, 'orphan.mjs'), PERSONAS);

    const result = validateRuntimePersonas(path.join(directory, 'server.mjs'));

    expect(result.findings).toEqual([]);
    expect(result.files).toEqual(['chunk.mjs', 'persona-route.mjs', 'server.mjs']);
  });

  it('reports duplicate public profiles and private target identifiers concisely', () => {
    const directory = fixture();
    writeFileSync(
      path.join(directory, 'server.mjs'),
      `import "./persona-route.mjs";\n${PERSONAS}\nconst privateOverlay = "acme";\n`
    );
    writeFileSync(path.join(directory, 'persona-route.mjs'), PERSONAS);

    const result = validateRuntimePersonas(path.join(directory, 'server.mjs'));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('business-analyst marker'),
        expect.stringContaining('marketing-scientist marker'),
        'private target persona identifier found in server.mjs',
      ])
    );
    expect(result.findings.join('\n')).not.toContain(PERSONAS);
  });
});
