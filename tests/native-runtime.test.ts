import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('shared package loads in native Node without a TypeScript transformer', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('@quiet/shared')"], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
