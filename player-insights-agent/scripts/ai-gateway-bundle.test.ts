import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const BUNDLE = readFileSync(resolve(REPO, 'databricks.yml'), 'utf8');

describe('AI Gateway bundle contract', () => {
  it('keeps direct and Gateway destinations side by side with neutral public defaults', () => {
    expect(BUNDLE).toMatch(/\n  llm_direct_endpoint:\n[\s\S]*?default: databricks-claude-sonnet-4-6/);
    expect(BUNDLE).toMatch(/\n  llm_gateway_endpoint:\n[\s\S]*?default: ""/);
    expect(BUNDLE).toMatch(/\n  llm_gateway:\n[\s\S]*?default: ""/);
  });

  it('does not track a private target override or its Gateway identifier', () => {
    const overridePath = resolve(REPO, '.databricks/bundle/example/variable-overrides.json');
    const override = JSON.parse(readFileSync(overridePath, 'utf8')) as Record<string, unknown>;
    const privateGateway = String(override.llm_gateway_endpoint ?? '');
    expect(privateGateway).not.toBe('');
    expect(override.llm_gateway).toBe('mlflow');

    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO }).toString('utf8').split('\0').filter(Boolean);
    expect(tracked).not.toContain('.databricks/bundle/example/variable-overrides.json');
    for (const path of tracked) {
      expect(readFileSync(resolve(REPO, path), 'utf8'), path).not.toContain(privateGateway);
    }
  });
});
